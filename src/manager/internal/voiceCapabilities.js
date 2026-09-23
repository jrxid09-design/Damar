"use strict";

/**
 * W8-IW1 — VOICE I/O CAPABILITY FAMILY (Manager-owned execution ownership).
 *
 * The voice providers are INGRESS, NEVER AUTHORITY. This module is the only
 * place that starts an audio process for the voice cluster: the providers hold
 * no `child_process` require and no `spawn`. Capture and playback are
 * capabilities and must pass authority first:
 *
 *   voice provider
 *     -> Manager-owned request
 *     -> authority (loadAndEvaluateAuthority)
 *     -> exact capability + exact operation
 *     -> canonical capability execution bridge
 *     -> composition-registered driver (spawn, fixed argv)
 *     -> Verification + durable audit acknowledgement
 *
 * Laws: TOOL != AUTHORITY. CAPABILITY REGISTERED != AUTHORITY.
 * MIGRATION != AUTHORIZATION. The binaries and their arguments are fixed here;
 * a caller cannot substitute a command. Deny-until-ratified: with no owner
 * grant, no audio process starts.
 *
 * The audio bytes are the caller's data, not its authority. They are digested
 * as a length plus a hash so the request stays inert and a changed buffer is a
 * different request.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const pexec = promisify(execFile);

const CAPABILITY_ID = "voice.audio";
const SAMPLE_RATE = 16000;

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

const OPERATIONS = Object.freeze(["probeOutput", "play", "probeInput", "capture", "level", "synthesize"]);

const PLAYERS = Object.freeze(["ffplay", "aplay", "powershell"]);
const RECORDERS = Object.freeze(["ffmpeg", "arecord"]);

const runtimeGate = new WeakSet();

function isBytes(value) {
    return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

/** Caller input is read exactly once. A getter that answers differently on a
 *  second read cannot swap the binary between the check and the spawn. */
function readParameters(operation, parameters) {
    const p = parameters && typeof parameters === "object" ? parameters : {};
    const out = {};
    switch (operation) {
        case "probeOutput":
            out.player = p.player;
            if (out.player !== undefined && !PLAYERS.includes(out.player)) return "PLAYER_UNKNOWN";
            return out;
        case "play":
            out.player = p.player;
            const audio = p.audio;
            out.audio = isBytes(audio) ? Buffer.from(audio) : audio;
            if (!PLAYERS.includes(out.player)) return "PLAYER_UNKNOWN";
            if (!isBytes(out.audio) || out.audio.length === 0) return "AUDIO_MALFORMED";
            return out;
        case "probeInput":
            out.recorder = p.recorder;
            if (out.recorder !== undefined && !RECORDERS.includes(out.recorder)) return "RECORDER_UNKNOWN";
            return out;
        case "capture":
            out.recorder = p.recorder;
            out.durationMs = p.durationMs;
            if (!RECORDERS.includes(out.recorder)) return "RECORDER_UNKNOWN";
            if (!Number.isFinite(out.durationMs) || out.durationMs <= 0 || out.durationMs > 60000) return "DURATION_MALFORMED";
            return out;
        case "level":
            out.recorder = p.recorder;
            out.frames = p.frames;
            if (!RECORDERS.includes(out.recorder)) return "RECORDER_UNKNOWN";
            if (!Number.isFinite(out.frames) || out.frames <= 0 || out.frames > 16000) return "FRAMES_MALFORMED";
            return out;
        case "synthesize":
            out.voice = typeof p.voice === "string" ? p.voice : "";
            out.text = typeof p.text === "string" ? p.text.slice(0, 4000) : "";
            if (!/^[A-Za-z]{2}-[A-Za-z]{2}-\w+$/.test(out.voice)) return "VOICE_MALFORMED";
            if (out.text.trim() === "") return "TEXT_EMPTY";
            return out;
        default:
            return "OPERATION_UNBOUND";
    }
}

function digestAudio(audio) {
    const buf = Buffer.from(audio);
    return { bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

/** The argument vectors are fixed per player/recorder. Nothing the caller
 *  supplies is interpolated except the temp path this module created. */
function playerArgs(player, file) {
    if (player === "powershell") {
        return ["powershell", ["-NoProfile", "-Command",
            `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`]];
    }
    if (player === "aplay") return ["aplay", ["-q", file]];
    return ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]];
}

function recorderArgs(recorder, file, seconds) {
    if (recorder === "arecord") {
        return ["arecord", ["-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-d", String(seconds), file]];
    }
    const input = process.platform === "win32"
        ? ["-f", "dshow", "-i", "audio=default"]
        : ["-f", "alsa", "-i", "default"];
    return ["ffmpeg", [...input, "-t", String(seconds), "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", "-y", file]];
}

function levelArgs(recorder) {
    if (recorder === "arecord") return ["arecord", ["-t", "raw", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1"]];
    const input = process.platform === "win32"
        ? ["-f", "dshow", "-i", "audio=default"]
        : ["-f", "alsa", "-i", "default"];
    return ["ffmpeg", [...input, "-ar", String(SAMPLE_RATE), "-ac", "1", "-f", "s16le", "pipe:1"]];
}

function run(spawnImpl, cmd, args, { timeoutMs = 30000, collect = false } = {}) {
    const child = spawnImpl(cmd, args, { stdio: collect ? ["ignore", "pipe", "ignore"] : "ignore", windowsHide: true });
    return new Promise((resolve, reject) => {
        const chunks = [];
        if (collect) child.stdout.on("data", c => chunks.push(c));
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
        child.once("error", err => { clearTimeout(timer); reject(err); });
        child.once("exit", code => {
            clearTimeout(timer);
            if (code === 0) resolve(collect ? Buffer.concat(chunks) : Buffer.alloc(0));
            else reject(new Error(code === null ? "killed" : `exit ${code}`));
        });
    });
}

function realDrivers(spawnImpl, execFileImpl) {
    const spawnFn = spawnImpl || spawn;
    const execFn = execFileImpl || pexec;
    return {
        probeOutput: async ({ parameters }) => {
            const [cmd, args] = parameters.player === "powershell"
                ? ["powershell", ["-NoProfile", "-Command", "exit 0"]]
                : [parameters.player, parameters.player === "aplay" ? ["--version"] : ["-version"]];
            await pexec(cmd, args, { timeout: 3000 });
            return { ok: true, player: parameters.player };
        },
        play: async ({ parameters }) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-spk-"));
            try {
                const file = path.join(dir, "out.mp3");
                fs.writeFileSync(file, Buffer.from(parameters.audioBytes, "base64"));
                const [cmd, args] = playerArgs(parameters.player, file);
                await run(spawnFn, cmd, args);
                return { ok: true, player: parameters.player, ...digestAudio(Buffer.from(parameters.audioBytes, "base64")) };
            } finally {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        },
        probeInput: async ({ parameters }) => {
            await pexec(parameters.recorder, parameters.recorder === "arecord" ? ["--version"] : ["-version"], { timeout: 3000 });
            return { ok: true, recorder: parameters.recorder };
        },
        capture: async ({ parameters }) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-mic-"));
            try {
                const file = path.join(dir, "rec.wav");
                const seconds = Math.max(1, Math.ceil(parameters.durationMs / 1000));
                const [cmd, args] = recorderArgs(parameters.recorder, file, seconds);
                await run(spawnFn, cmd, args, { timeoutMs: (seconds + 5) * 1000 });
                const audio = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
                return { ok: true, recorder: parameters.recorder, ...digestAudio(audio) };
            } finally {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        },
        synthesize: async ({ parameters }) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-edge-"));
            try {
                const out = path.join(dir, "s.mp3");
                await execFn("edge-tts", ["--voice", parameters.voice, "--text", parameters.text, "--write-media", out],
                    { timeout: 60000, windowsHide: true });
                const audio = fs.readFileSync(out);
                return { ok: true, ...digestAudio(audio), audioBytes: audio.toString("base64"), contentType: "audio/mpeg" };
            } finally {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
            }
        },
        level: async ({ parameters }) => {
            const [cmd, args] = levelArgs(parameters.recorder);
            const pcm = await run(spawnFn, cmd, args, { timeoutMs: 5000, collect: true });
            const samples = Math.floor(pcm.length / 2);
            let sum = 0;
            for (let i = 0; i + 1 < pcm.length && i / 2 < parameters.frames; i += 2) sum += pcm.readInt16LE(i) ** 2;
            const rms = samples === 0 ? 0 : Math.min(1, Math.sqrt(sum / Math.min(samples, parameters.frames)) / 32768);
            return { ok: true, recorder: parameters.recorder, rms: Number(rms.toFixed(4)) };
        }
    };
}

function createVoiceCapabilityRuntime({
    authorityStore = null, acknowledge = null, driverOverrides = null,
    replayStore = null, spawnImpl = null, execFileImpl = null
} = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore });
    const drivers = realDrivers(spawnImpl, execFileImpl);
    const invocations = new Map();
    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    const capabilityId = canonicalCapabilityId(CAPABILITY_ID);
    for (const operation of OPERATIONS) {
        const override = driverOverrides?.[operation];
        const driver = typeof override === "function" ? override : drivers[operation];
        bridge.registerCapability({
            capabilityId, operation, consequential: true,
            driverId: `voice.audio.${operation}`,
            driver: async ctx => {
                invocations.set(operation, (invocations.get(operation) ?? 0) + 1);
                return driver(ctx);
            }
        });
    }
    bridge.registerVerifier(capabilityId, async (_p, result) => ({
        checks: [
            { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
            { name: "driver-reported-no-failure", passed: !(result && result.ok === false) }
        ]
    }));

    async function authorize({ identity = {}, scope = [], nowMs = Date.now() } = {}) {
        if (!authorityStore) return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_UNAVAILABLE" };
        try {
            const evaluation = await loadAndEvaluateAuthority(authorityStore, { capabilityId, action: "execute", scope, identity, nowMs });
            return evaluation?.allowed === true
                ? { allowed: true, state: STATE.AUTHORIZED, reason: "AUTHORIZED", evaluation }
                : { allowed: false, state: STATE.AVAILABLE_BUT_NOT_AUTHORIZED, reason: evaluation?.reasonCode ?? "DENIED" };
        } catch (error) {
            return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_ERROR", detail: error.message };
        }
    }

    const runtime = {
        async execute({ operation, parameters = {}, requestId, identity = {}, scope = [], nowMs = Date.now(), signal = null } = {}) {
            if (!OPERATIONS.includes(operation)) return { outcome: OUTCOME.REFUSED, reason: "OPERATION_UNBOUND", capabilityId, operation };
            const snap = readParameters(operation, parameters);
            if (typeof snap === "string") return { outcome: OUTCOME.REFUSED, reason: snap, capabilityId, operation };
            // The audio bytes are digested, not passed through: a buffer is not
            // inert data, and its content is bound into the request digest.
            const bound = snap.audio ? { ...snap, audio: digestAudio(snap.audio), audioBytes: Buffer.from(snap.audio).toString("base64") } : { ...snap };
            const auth = await authorize({ identity, scope, nowMs });
            if (!auth.allowed) {
                return { ok: false, denied: true, outcome: OUTCOME.DENIED, state: auth.state, capabilityId, operation, reason: auth.reason };
            }
            return bridge.execute({ capabilityId, operation, parameters: bound, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount(operation) {
            return operation ? (invocations.get(operation) ?? 0) : [...invocations.values()].reduce((n, c) => n + c, 0);
        }
    };
    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;
function installVoiceCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("voice capability runtime was not created by this module");
    if (installed !== null) throw new Error("voice capability runtime already installed");
    installed = runtime;
    return true;
}
function voiceRuntime() {
    if (installed === null) installed = createVoiceCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}
function isVoiceCapabilityRuntime(runtime) { return runtimeGate.has(runtime); }

module.exports = {
    CAPABILITY_ID, OPERATIONS, STATE, PLAYERS, RECORDERS,
    createVoiceCapabilityRuntime, installVoiceCapabilityRuntime, voiceRuntime, isVoiceCapabilityRuntime
};
