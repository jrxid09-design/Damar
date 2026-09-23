"use strict";

/**
 * W8-IW1 — voice I/O capability family, adversarial.
 *
 * The physical audio process is the `spawnImpl` double below. If it is called,
 * sound was played or a microphone was opened. Every assertion checks that
 * double's call count, so removing the authority gate or the binding makes a
 * test fail.
 */

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createVoiceCapabilityRuntime, STATE } = require("../../../src/manager/internal/voiceCapabilities.js");

function withSubstrate(opts = {}) {
    return createVoiceCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

const ack = () => ({ ok: true, receipt: "voice-ack" });

function grantStore(grants) {
    const caps = new Map(grants.map(g => [g.capabilityId, g]));
    return {
        async getCapability(id) {
            const g = caps.get(id);
            if (!g) return null;
            return {
                capabilityId: id, status: g.status ?? "ACTIVE", generation: 0,
                payload: {
                    subject: "owner", capabilityId: id, kind: "root", actions: ["execute"],
                    scope: g.scope ?? [], allowedPurposes: [], restrictions: { kind: "unrestricted" },
                    maxExecutions: null, identityBinding: g.identityBinding ?? null,
                    notBefore: null, expiresAt: null, issuedAt: new Date().toISOString()
                }
            };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

function spawnDouble() {
    const calls = [];
    const spawn = (cmd, args) => {
        calls.push({ cmd, args: [...args] });
        const child = new (require("node:events").EventEmitter)();
        child.stdout = new (require("node:events").EventEmitter)();
        child.kill = () => {};
        process.nextTick(() => child.emit("exit", 0));
        return child;
    };
    return { calls, spawn };
}

const GRANT = [{ capabilityId: "voice.audio" }];
const AUDIO = Buffer.from("mp3-bytes");

test("voice/structural: the providers start no process", () => {
    for (const file of ["audioOutput.js", "audioInput.js"]) {
        const code = fs.readFileSync(path.join(__dirname, "../../../src/voice/providers", file), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        assert.equal(/child_process/.test(code), false, file);
        assert.equal(/\b(spawn|execFile|exec|fork)\s*\(/.test(code), false, file);
    }
});

test("voice/authority: no authority store starts zero audio processes", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ acknowledge: ack, spawnImpl: fx.spawn });
    for (const request of [
        { operation: "play", parameters: { player: "ffplay", audio: AUDIO } },
        { operation: "capture", parameters: { recorder: "ffmpeg", durationMs: 1000 } },
        { operation: "level", parameters: { recorder: "ffmpeg", frames: 160 } }
    ]) {
        const result = await runtime.execute(request);
        assert.equal(result.denied, true, request.operation);
        assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
        assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    }
    assert.equal(fx.calls.length, 0);
    assert.equal(runtime.invocationCount(), 0);
});

test("voice/authority: a missing grant denies and starts nothing", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore([]), acknowledge: ack, spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.denied, true);
    assert.equal(result.reason, "CAP_NOT_FOUND");
    assert.equal(fx.calls.length, 0);
});

test("voice/authority: a ratified grant plays exactly once, with the fixed argv", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.outcome, "EXECUTED_VERIFIED", JSON.stringify(result));
    assert.equal(result.receipt, "voice-ack");
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].cmd, "ffplay");
    assert.deepEqual(fx.calls[0].args.slice(0, 4), ["-nodisp", "-autoexit", "-loglevel", "quiet"]);
});

test("voice/authority: a caller cannot choose the binary", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    for (const player of ["sh", "cmd.exe", "ffmpeg", "ffplay; id"]) {
        const result = await runtime.execute({ operation: "play", parameters: { player, audio: AUDIO } });
        assert.equal(result.outcome, "REFUSED", player);
        assert.equal(result.reason, "PLAYER_UNKNOWN");
    }
    assert.equal(fx.calls.length, 0);
});

test("voice/authority: a forged result cannot be published as success", async () => {
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { play: async () => new (class Fake { ok = true; })() }
    });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.outcome, "UNVERIFIED");
    assert.match(result.reason, /MALFORMED_RESULT/);
});

test("voice/authority: an unknown result shape fails closed", async () => {
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { play: async () => Symbol("nope") }
    });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.outcome, "UNVERIFIED");
});

test("voice/binding: an unknown operation starts nothing", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "record-call", parameters: {} });
    assert.equal(result.outcome, "REFUSED");
    assert.equal(result.reason, "OPERATION_UNBOUND");
    assert.equal(fx.calls.length, 0);
});

test("voice/binding: a different buffer is a different request, and a replay is not", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    const first = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    const replay = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(first.outcome, "EXECUTED_VERIFIED");
    assert.equal(replay.reason, "REPLAY");
    assert.equal(fx.calls.length, 1, "replay duplicated the playback");
    const changed = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: Buffer.from("other") } });
    assert.equal(changed.outcome, "EXECUTED_VERIFIED");
    assert.equal(fx.calls.length, 2);
});

test("voice/binding: principal and scope mismatch start nothing", async () => {
    const fx = spawnDouble();
    const bound = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "voice.audio", identityBinding: { principals: ["owner"] } }]),
        acknowledge: ack, spawnImpl: fx.spawn
    });
    const intruder = await bound.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO }, identity: { principal: "intruder" } });
    assert.equal(intruder.denied, true);
    assert.equal(intruder.reason, "CAP_IDENTITY_MISMATCH");

    const scoped = withSubstrate({
        authorityStore: grantStore([{ capabilityId: "voice.audio", scope: ["output:speakers"] }]),
        acknowledge: ack, spawnImpl: fx.spawn
    });
    const unscoped = await scoped.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(unscoped.denied, true);
    assert.equal(unscoped.reason, "CAP_SCOPE_MISMATCH");
    assert.equal(fx.calls.length, 0);
});

test("voice/cancel: abort before invocation starts nothing", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO }, signal: { aborted: true } });
    assert.equal(result.outcome, "CANCELLED_BEFORE_EFFECT");
    assert.equal(result.effectInvoked, false);
    assert.equal(fx.calls.length, 0);
});

test("voice/cancel: abort after invocation stays ambiguous", async () => {
    let signal;
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { play: async () => { signal.aborted = true; return { ok: true, player: "ffplay" }; } }
    });
    signal = { aborted: false };
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO }, signal });
    assert.equal(result.outcome, "AMBIGUOUS_AFTER_INVOCATION");
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
});

test("voice/deadman: a player that errors cannot become success", async () => {
    const fx = { calls: [], spawn() { fx.calls.push(1); const e = new (require("node:events").EventEmitter)(); e.stdout = e; e.kill = () => {}; process.nextTick(() => e.emit("error", new Error("device gone"))); return e; } };
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: ack, spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(fx.calls.length, 1);
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
});

test("voice/verify: a driver-reported failure cannot become success", async () => {
    const runtime = withSubstrate({
        authorityStore: grantStore(GRANT), acknowledge: ack,
        driverOverrides: { play: async () => ({ ok: false, error: "no device" }) }
    });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.outcome, "UNVERIFIED");
});

test("voice/audit: acknowledgement failure cannot become success", async () => {
    const fx = spawnDouble();
    const runtime = withSubstrate({ authorityStore: grantStore(GRANT), acknowledge: () => ({ ok: false }), spawnImpl: fx.spawn });
    const result = await runtime.execute({ operation: "play", parameters: { player: "ffplay", audio: AUDIO } });
    assert.equal(result.outcome, "UNVERIFIED");
    assert.equal(result.reason, "AUDIT_NOT_ACKNOWLEDGED");
    assert.equal(fx.calls.length, 1);
});

test("voice/legacy: the production adapters cannot play without a grant", async () => {
    const { AudioOutput } = require("../../../src/voice/providers/audioOutput.js");
    const output = new AudioOutput({ backend: "cli" });
    await output.probe();
    assert.equal(output.available, false, "probe spawns nothing without a grant");
    await output.play(AUDIO);
    assert.equal(output.status().playing, false);
});
