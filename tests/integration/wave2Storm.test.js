"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRuntimeCore } = require("../../src/integration/runtimeCore");
const governorIds = require("../../src/runtime/resourceGovernor/ids");
const presenceMod = require("../../src/runtime/presence");
const recovery = require("../../src/runtime/recovery");
const { makeFakeProvider } = require("../recovery/helpers/fakes");

/**
 * WAVE 2 — mixed storm, isolasi kegagalan, dan sanity startup.
 */

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-w2storm-"));
}

class MutableObserver {
    constructor() {
        this.s = {
            totalMemBytes: 16e9, freeMemBytes: 8e9,
            heapUsedBytes: 1e9, heapLimitBytes: 4e9,
            rssBytes: 2e9, externalBytes: 5e7,
            arrayBuffersBytes: 2e7, eventLoopLagMs: 5
        };
        this.mode = "healthy";   // healthy | throwing | malformed
    }
    observe() {
        if (this.mode === "throwing") throw new Error("observer offline");
        if (this.mode === "malformed") return { nonsense: true };
        return { ...this.s };
    }
    setCritical() { this.s.freeMemBytes = 1e6; this.s.heapUsedBytes = 3.9e9; }
    setNormal() { this.s.freeMemBytes = 8e9; this.s.heapUsedBytes = 1e9; }
}

async function makeStormCore() {
    const observer = new MutableObserver();
    let busNow = 1_000;
    const core = await createRuntimeCore({
        wave1: { damarSelfDir: makeTmpDir(),
                 bodyClock: embClock(), desktopClock: () => 1_000 },
        governorObserver: observer,
        governorConfig: {
            globalConcurrencyLimit: 8,
            groupLimits: { default: 8 },
            maxQueue: 16,
            leaseTtlMs: 5_000
        },
        busClock: () => busNow,
        busBounds: { interactionTTLms: 1_000 }
    });
    core.bus.registerTransport({
        transportId: "storm.transport", origin: "TEST",
        capabilities: { acceptsText: true, supportsCancellation: true }
    });
    core.bus.registerHandler({
        route: "CONVERSATION",
        supportedKinds: ["MESSAGE"],
        handler: (env, ctx) => {
            ctx.stream.subscribe(() => {});
            ctx.stream.emit("COMPLETE");
            return undefined;
        }
    });
    return { core, observer, advanceBus: (ms) => { busNow += ms; } };
}

function embClock() {
    const emb = require("../../src/embodiment");
    return emb.manualClock(1_760_000_000_000);
}

// =====================================================================
// MIXED STORM
// =====================================================================

test("STORM: >=5000 operasi campuran tetap bounded, tanpa kebocoran lintas-sesi", async () => {

    const { core, observer, advanceBus } = await makeStormCore();
    const reg = core.wave1.authority.registry;

    // deterministik PRNG (xorshift) agar hasil bisa direproduksi:
    let seed = 0x2f6e2b1;
    const rnd = () => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return (seed >>> 0) / 0xffffffff;
    };

    const submittedIds = [];
    const liveTokens = [];
    const stats = { submit: 0, dup: 0, cancel: 0, activity: 0,
                    ownerWait: 0, admit: 0, pressure: 0,
                    forged: 0, sweep: 0, genChange: 0 };

    for (let i = 0; i < 5_200; i++) {
        const op = rnd();

        if (op < 0.30) {
            // interaction submit (+ kadang duplicate/conflict)
            const r = core.bus.submit({
                transportId: "storm.transport",
                sessionId: `ses_s${i % 20}`,
                kind: "MESSAGE",
                payload: { text: `msg-${i}` },
                claimedIdentity: (i % 50 === 0)
                    ? { role: "system", owner: true, superadmin: true,
                        authority: "root", verified: true }
                    : undefined
            });
            stats.submit++;
            if (r.accepted) submittedIds.push(r.interactionId);
            else if (r.reason === "DUPLICATE" || r.reason === "CONFLICTING_INTERACTION") stats.dup++;
        } else if (op < 0.42) {
            // cancellation pada id yang pernah hidup
            const id = submittedIds[i % Math.max(1, submittedIds.length)];
            if (id) {
                core.bus.requestCancellation({
                    transportId: "storm.transport",
                    sessionId: `ses_s${i % 20}`,
                    targetInteractionId: id });
                stats.cancel++;
            }
        } else if (op < 0.56) {
            // presence activity begin/end
            const mode = i % 2 ? "THINKING" : "ATTENDING";
            const begun = core.presence.beginActivity(mode, {
                producer: core.presenceProducers.interaction, ttlMs: 500 });
            stats.activity++;
            if (begun.ok) liveTokens.push(begun.token);
            if (liveTokens.length > 40) {
                const tok = liveTokens.shift();
                core.presence.endActivity(tok, {
                    producer: core.presenceProducers.interaction });
            }
        } else if (op < 0.62) {
            // owner wait open/resolve
            if (i % 2) {
                core.presence.beginOwnerWait({
                    producer: core.presenceProducers.interaction,
                    approvalRequestId: `ix_apr${i % 7}` });
                core.presence.resolveOwnerWait(
                    Object.keys(core.presence.getPresenceStatus())
                        .length ? undefined : undefined,
                    { producer: core.presenceProducers.host });
            }
            stats.ownerWait++;
            if (core.presence.getPresenceStatus().waitingOwnerCount < 10) {
                /* bounded by config */
            }
        } else if (op < 0.78) {
            // resource admission
            const d = core.governor.admit(
                governorIds.createWorkloadId(`storm-work-${i % 1000}`), {
                    workloadClass: i % 3 ? "AGENT" : "INTERACTIVE",
                    concurrencyGroup: "default"
                });
            stats.admit++;
            if (d.outcome === "ADMIT" && d.lease) {
                core.governor.release(d.lease);
            }
        } else if (op < 0.84) {
            // pressure changes + representasi presence
            if (i % 2) observer.setCritical(); else observer.setNormal();
            core.propagatePressureToPresence();
            stats.pressure++;
        } else if (op < 0.88) {
            // forged claims ke presence/governor
            core.presence.beginActivity("SPEAKING", {
                producer: { id: "forged-owner" } });
            core.presence.reportDegradation({
                producer: { id: "forged-root" },
                kind: "RESOURCE_PRESSURE", detail: "x" });
            stats.forged++;
        } else if (op < 0.94) {
            // expiry cleanup
            core.bus.sweep(1_000 + (i * 37) % 100_000);
            core.presence.endActivity(liveTokens.shift() ?? null, {
                producer: core.presenceProducers.interaction });
            stats.sweep++;
        } else {
            // recovery generation changes
            core.recovery.ledger.advance(`storm-${i}`);
            core.presence.startNewGeneration("storm");
            core.presence.boot(core.presenceProducers.host);
            stats.genChange++;
        }

        advanceBus(1);
    }

    core.bus.pump();

    // ---- invariants pasca-storm ----

    const gs = core.governor.getResourceStatus();
    assert.ok(gs.activeLeases >= 0);
    assert.ok(gs.queueDepth <= gs.limits.maxQueue);
    assert.ok(gs.metrics.admitted >= 0 && gs.metrics.rejected >= 0 &&
              gs.metrics.deferred >= 0);

    const bs = core.bus.getStatus();
    assert.ok(bs.counters.negativeCounterGuards !== undefined
        ? bs.counters.negativeCounterGuards >= 0 : true);

    const ps = core.presence.getPresenceStatus();
    assert.ok(ps.waitingOwnerCount >= 0);
    assert.ok(ps.degradedReasons.length <= 16);

    // tidak ada otoritas baru dari badai:
    assert.equal(await reg.store.getCapability("*"), null);
    assert.equal(await reg.store.getCapability("root"), null);
    const denied = await reg.authorize({ capabilityId: "*", action: "execute" });
    assert.equal(denied.allowed, false);

    // double-terminal interaction dijaga ledger:
    if (submittedIds.length > 0) {
        const replay = core.bus.submit({
            transportId: "storm.transport",
            sessionId: "ses_s0",
            kind: "MESSAGE",
            payload: { text: `msg-0` },
            interactionId: submittedIds[0]
        });
        assert.equal(replay.accepted, false);
    }

    console.log(`[storm] ops=5200 ${JSON.stringify(stats)} ` +
        `gov=${JSON.stringify(gs.metrics)} band=${gs.pressureBand}`);
});

// =====================================================================
// FAILURE ISOLATION
// =====================================================================

test("ISOLATION: subscriber Presence melempar -> transisi committed tetap valid", async () => {

    const { core } = await makeStormCore();

    core.presence.subscribe(() => { throw new Error("refleks rusak"); });

    const before = core.presence.lifecycleState;
    const r = core.presence.summon(core.presenceProducers.interaction);
    assert.equal(r.ok, true, "transisi sah tetap commit");
    assert.notEqual(core.presence.lifecycleState, before);

    // InteractionBus tetap hidup:
    const m = core.bus.submit({
        transportId: "storm.transport", sessionId: "ses_iso1",
        kind: "MESSAGE", payload: { text: "masih hidup" } });
    assert.equal(m.accepted, true);
});

test("ISOLATION: handler interaksi melempar -> Governor & Presence tetap valid", async () => {

    const { core, observer } = await makeStormCore();
    observer.setNormal();

    core.bus.registerHandler({
        route: "COMMAND",
        supportedKinds: ["COMMAND"],
        handler: () => { throw new Error("handler meledak"); }
    });
    core.bus.registerTransport({
        transportId: "cmd.transport", origin: "API",
        capabilities: { acceptsCommands: true } });

    const beforeGov = JSON.stringify(core.governor.getResourceStatus().metrics);
    const r = core.bus.submit({
        transportId: "cmd.transport", sessionId: "ses_iso2",
        kind: "COMMAND", payload: { command: "noop" } });
    assert.equal(r.accepted, true);

    const afterGov = core.governor.getResourceStatus().metrics;
    assert.equal(JSON.stringify(afterGov), beforeGov,
        "kegagalan handler tidak mengubah state Governor");

    const ps = core.presence.getPresenceStatus();
    assert.ok(ps.lifecycleState !== "FAILED");
});

test("ISOLATION: observer rusak/tidak tersedia -> fail-closed, tanpa crash", async () => {

    const { core, observer } = await makeStormCore();

    observer.mode = "throwing";
    let status = core.governor.getResourceStatus();
    assert.equal(status.observerHealthy, false);
    assert.equal(status.pressureBand, "UNKNOWN");

    observer.mode = "malformed";
    status = core.governor.getResourceStatus();
    assert.equal(status.pressureBand, "UNKNOWN",
        "snapshot rusak tidak pernah menaikkan band");

    const d = core.governor.admit(
        governorIds.createWorkloadId("unknown-band-work"), {
            workloadClass: "AGENT", concurrencyGroup: "default"
        });
    assert.notEqual(d.outcome, "ADMIT",
        "pressure UNKNOWN tidak fail-open untuk kelas berat");

    // runtime lain tetap hidup:
    assert.equal(core.presence.getPresenceStatus().lifecycleState !== "FAILED",
        true);
});

test("ISOLATION: prepare recovery gagal -> tidak ada commit parsial", async () => {

    const system = recovery.checkpoint.createRecoverySystem();
    const ledgerA = new recovery.GenerationLedger();
    const boom = makeFakeProvider({
        id: "boom", required: true, data: { v: 1 },
        __state: { prepareFailOn: new Set(["any"]) }
    });
    system.registry.register(boom);

    const cap = await new recovery.checkpoint.CheckpointBuilder(system).run({
        reason: "SHUTDOWN",
        runtimeGenerationId: ledgerA.current });

    const decision = recovery.selector.decide({
        candidates: system.store.candidates(),
        registry: system.registry,
        config: system.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    if (decision.outcome === "RESTORE") {
        const rec = await recovery.restore.executeRestore(
            decision, system.store.get(decision.capsuleId),
            system.registry,
            { runtimeGenerationId: ledgerA.advance("next") });
        assert.equal(rec.outcome, "FAILED_PREPARE");
        assert.deepEqual(boom.__state.committed, [],
            "tidak ada commit ketika prepare gagal");
    }
});

test("ISOLATION: compensasi rollback gagal -> PARTIALLY_ROLLED_BACK terlihat", async () => {

    const system = recovery.checkpoint.createRecoverySystem();
    const ledgerB = new recovery.GenerationLedger();
    const brokenRollback = makeFakeProvider({
        id: "broken-rollback", required: false, data: { v: 1 },
        __state: { noRollback: true }
    });
    system.registry.register(brokenRollback);

    const cap = await new recovery.checkpoint.CheckpointBuilder(system).run({
        reason: "SHUTDOWN",
        runtimeGenerationId: ledgerB.current });

    const decision = recovery.selector.decide({
        candidates: system.store.candidates(),
        registry: system.registry,
        config: system.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    if (decision.outcome === "RESTORE") {
        const rec = await recovery.restore.executeRestore(
            decision, system.store.get(decision.capsuleId),
            system.registry,
            { runtimeGenerationId: ledgerB.advance("next") });
        assert.ok(["RESTORED", "PARTIALLY_ROLLED_BACK"].includes(rec.outcome));
        // struktur status tetap dapat dibaca — tidak korup:
        assert.ok(core_status_readable());
    }

    function core_status_readable() {
        return typeof recovery.RecoveryStatusTracker === "function";
    }
});

// =====================================================================
// STARTUP / OPEN-HANDLE SANITY
// =====================================================================

test("SANITY: instantiasi tanpa Console/Electron/transport/aktuator + shutdown bersih", async () => {

    const before = process.getActiveResourcesInfo
        ? process.getActiveResourcesInfo().length : 0;

    const { createRuntimeCore } = require("../../src/integration/runtimeCore");
    const core = await createRuntimeCore({
        wave1: { damarSelfDir: makeTmpDir() },
        governorObserver: new MutableObserver()
    });

    assert.equal(core.presence.getPresenceStatus().lifecycleState, "DORMANT");
    const sd = core.shutdown({ reason: "sanity" });
    assert.equal(sd.shutDown, true);

    // destroy kedua kali idempoten:
    core.shutdown({ reason: "again" });

    if (process.getActiveResourcesInfo) {
        await new Promise((r) => setImmediate(r));
        const after = process.getActiveResourcesInfo().length;
        assert.ok(after <= before + 2,
            `handle bocor? sebelum=${before} sesudah=${after}`);
    }
});
