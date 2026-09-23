"use strict";

/**
 * W8-IW1 — MEDIA RESOLVE CAPABILITY (Manager-owned execution ownership).
 *
 * streamResolver is INGRESS, NEVER AUTHORITY. This module is the only place
 * that runs yt-dlp: src/services/streamResolver.js holds no child_process
 * require. Resolving and downloading a video are capability requests and must
 * pass authority first. The binary is fixed (yt-dlp) and the only caller input
 * that reaches it is a validated 11-character YouTube id, so a caller cannot
 * point it at an arbitrary URL or add an argument.
 *
 * Deny-until-ratified: with no owner grant, yt-dlp never starts.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { canonicalCapabilityId } = require("../../authority/canonical");
const { loadAndEvaluateAuthority } = require("../../authority/evaluate");
const { CanonicalCapabilityExecution, OUTCOME } = require("./canonicalCapabilityExecution");
const { createCanonicalAuditAcknowledger } = require("./canonicalAuditAcknowledger");
const { createCanonicalReplayLedger } = require("./canonicalReplayLedger");

const pexec = promisify(execFile);

const CAPABILITY_ID = "media.youtube";
const OPERATIONS = Object.freeze(["resolve", "download"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const STATE = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    AVAILABLE_BUT_NOT_AUTHORIZED: "AVAILABLE_BUT_NOT_AUTHORIZED",
    OWNER_RATIFICATION_REQUIRED: "OWNER_RATIFICATION_REQUIRED"
});

const runtimeGate = new WeakSet();

function cacheDir() { return path.join(os.tmpdir(), "damar-media"); }

/** Read the caller's fields once. Only a YouTube video id is accepted, so the
 *  value that reaches yt-dlp can only ever be a watch URL we build. */
function readParameters(operation, parameters) {
    const p = parameters && typeof parameters === "object" ? parameters : {};
    const videoId = typeof p.videoId === "string" ? p.videoId : "";
    if (!VIDEO_ID.test(videoId)) return "VIDEO_ID_MALFORMED";
    if (!OPERATIONS.includes(operation)) return "OPERATION_UNBOUND";
    return { videoId };
}

function realDrivers(execFileImpl) {
    const exec = execFileImpl || pexec;
    const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

    return {
        resolve: async ({ parameters }) => {
            const { stdout } = await exec("yt-dlp", [
                "-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]",
                "-g", "--no-warnings", "--no-playlist", watchUrl(parameters.videoId)
            ], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
            const link = String(stdout).trim().split("\n")[0].trim();
            return link.startsWith("http") ? { ok: true, url: link } : { ok: false, error: "NO_STREAM" };
        },
        download: async ({ parameters }) => {
            const dir = cacheDir();
            fs.mkdirSync(dir, { recursive: true });
            const out = path.join(dir, `${parameters.videoId}.mp4`);
            await exec("yt-dlp", [
                "--extractor-args", "youtube:player_client=mweb",
                "-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]",
                "-o", out, "--no-warnings", "--no-playlist", "--no-part",
                watchUrl(parameters.videoId)
            ], { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 });
            const size = fs.statSync(out).size;
            return size > 0 ? { ok: true, file: out, bytes: size } : { ok: false, error: "EMPTY_DOWNLOAD" };
        }
    };
}

function createMediaCapabilityRuntime({
    authorityStore = null, acknowledge = null, driverOverrides = null,
    replayStore = null, execFileImpl = null
} = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore });
    const drivers = realDrivers(execFileImpl);
    const invocations = new Map();
    bridge.installAuditAcknowledger(acknowledge ?? createCanonicalAuditAcknowledger());

    const capabilityId = canonicalCapabilityId(CAPABILITY_ID);
    for (const operation of OPERATIONS) {
        const override = driverOverrides?.[operation];
        const driver = typeof override === "function" ? override : drivers[operation];
        bridge.registerCapability({
            capabilityId, operation, consequential: true, driverId: `media.youtube.${operation}`,
            driver: async ctx => { invocations.set(operation, (invocations.get(operation) ?? 0) + 1); return { operation, ...await driver(ctx) }; }
        });
    }
    bridge.registerVerifier(capabilityId, async (parameters, result) => ({
        checks: [
            { name: "driver-returned-result", passed: result !== null && typeof result === "object" },
            { name: "driver-reported-no-failure", passed: !(result && result.ok === false) },
            { name: "stream-is-http", passed: result?.operation === "download" || /^https?:\/\//.test(result?.url ?? "") }
        ]
    }));

    async function authorize({ identity = {}, scope = [], nowMs = Date.now() } = {}) {
        if (!authorityStore) return { allowed: false, state: STATE.OWNER_RATIFICATION_REQUIRED, reason: "AUTHORITY_UNAVAILABLE" };
        try {
            const evaluation = await loadAndEvaluateAuthority(authorityStore, { capabilityId, action: "execute", scope, identity, nowMs });
            return evaluation?.allowed === true
                ? { allowed: true, state: STATE.AUTHORIZED, evaluation }
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
            const auth = await authorize({ identity, scope, nowMs });
            if (!auth.allowed) return { ok: false, denied: true, outcome: OUTCOME.DENIED, state: auth.state, capabilityId, operation, reason: auth.reason };
            return bridge.execute({ capabilityId, operation, parameters: snap, evaluation: auth.evaluation, requestId, signal });
        },
        invocationCount(operation) { return operation ? (invocations.get(operation) ?? 0) : [...invocations.values()].reduce((n, c) => n + c, 0); },
        ratificationProposal() {
            const body = { capabilityId, operations: [...OPERATIONS], status: "UNSIGNED_NOT_ACTIVE" };
            return Object.freeze({ ...body, proposalDigest: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") });
        }
    };
    runtimeGate.add(runtime);
    return Object.freeze(runtime);
}

let installed = null;
function installMediaCapabilityRuntime(runtime) {
    if (!runtimeGate.has(runtime)) throw new TypeError("media capability runtime was not created by this module");
    if (installed !== null) throw new Error("media capability runtime already installed");
    installed = runtime;
    return true;
}
function mediaRuntime() {
    if (installed === null) installed = createMediaCapabilityRuntime({ replayStore: createCanonicalReplayLedger() });
    return installed;
}

module.exports = { CAPABILITY_ID, OPERATIONS, STATE, createMediaCapabilityRuntime, installMediaCapabilityRuntime, mediaRuntime };
