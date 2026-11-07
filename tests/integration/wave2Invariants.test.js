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
const emb = require("../../src/embodiment");
const desktop = require("../../src/desktop");

/**
 * INTEGRATION WAVE 2 — invarian lintas-subsystem runtime foundations.
 *
 *   interaction != authority / authentication / actuation
 *   presence    != authority / execution priority / actuation
 *   admission   != authority ; pressure != permission
 *   recovery    != current reality / authority / auto-resumable
 */

// ---------------------------------------------------------------- helpers

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-w2-"));
}

class FakeObserver {
    constructor(state = {}) {
        this.s = {
            totalMemBytes: 16e9, freeMemBytes: 8e9,
            heapUsedBytes: 1e9, heapLimitBytes: 4e9,
            rssBytes: 2e9, externalBytes: 5e7,
            arrayBuffersBytes: 2e7, eventLoopLagMs: 5, ...state
        };
    }
    observe() { return { ...this.s }; }
}

async function makeCore({
    observerState = {}, governorConfig = {}, busBounds = undefined,
    damarSelfDir = makeTmpDir()
} = {}) {
    const govClock = { nowMs: () => 1_000_000 };
    const presenceClock = presenceMod.createManualClock(1_000);
    let busNow = 1_000;
    const core = await createRuntimeCore({
        wave1: {
            damarSelfDir,
            bodyClock: emb.manualClock(1_760_000_000_000),
            desktopClock: () => 1_000
        },
        governorObserver: new FakeObserver(observerState),
        governorConfig: {
            globalConcurrencyLimit: 4,
            groupLimits: { default: 4 },
            maxQueue: 8,
            leaseTtlMs: 60_000,
            ...governorConfig
        },
        governorClock: govClock,
        presenceClock,
        busClock: () => busNow,
        busBounds
    });
    return { core, presenceClock, advanceBus: (ms) => { busNow += ms; } };
}

function registerTextTransport(core, transportId = "test.transport") {
    core.bus.registerTransport({
        transportId,
        origin: "TEST",
        capabilities: {
            acceptsText: true, supportsCancellation: true,
            supportsApprovalResponses: true, acceptsAuthEvidence: true,
            acceptsEvents: true
        }
    });
    return transportId;
}

async function authorizeDeniedEverywhere(registry, pairs) {
    for (const [capabilityId, action] of pairs) {
        const attempt = await registry.authorize({ capabilityId, action });
        assert.equal(attempt.allowed, false,
            `authority BOCOR: ${capabilityId}/${action}`);
    }
}

async function issueRatifiedRoot(registry, {
    capabilityId = "infra.deploy", proposalId = "prop-w2",
    ratificationId = "rat-w2"
} = {}) {
    await registry.proposeEvolution({
        proposalId,
        createdBy: "acc",
        kind: "authority_expansion",
        problem: "wave2 test",
        proposedChange: "root grant via ratifikasi owner",
        requestedAuthority: {
            capabilityId, subject: "damar-core",
            actions: ["use"], maxExecutions: null
        }
    }, "acc");
    const deniedFirst = await registry.issueRatifiedRootGrant({
        proposalId, ratificationId });
    assert.equal(deniedFirst.allowed, false);
    await registry.ratify({
        ratificationId, proposalId,
        ownerIdentity: "operator", decision: "APPROVED"
    });
    const issued = await registry.issueRatifiedRootGrant({
        proposalId, ratificationId });
    assert.equal(issued.allowed, true);
    return issued.grant;
}

// =====================================================================
// A — INTERACTION -> PRESENCE
// =====================================================================

test("A: forged caller/transport identity tidak menjadi producer Presence", async () => {

    const { core } = await makeCore();
    registerTextTransport(core);

    const submitted = core.bus.submit({
        transportId: "test.transport",
        sessionId: "ses_a1",
        kind: "MESSAGE",
        payload: { text: "hi" },
        claimedIdentity: {
            role: "system", owner: true, superadmin: true,
            authority: "root", verified: true
        }
    });
    assert.equal(submitted.accepted, true);
    core.bus.pump();

    // Klaim pemanggil bukan identitas produsen Presence:
    const forgedBegin = core.presence.beginActivity("THINKING", {
        producer: { id: "forged-system-owner" },
        reason: "claimed by caller"
    });
    assert.equal(forgedBegin.ok, false,
        "produsen tak terdaftar tidak boleh memulai aktivitas");

    // Producer INTERACTION yang TERDAFTAR (via komposisi) boleh:
    // tapi klaim teks dari interaksi tetap bukan otentikasi.
    assert.notEqual(core.presence.lifecycleState, "FAILED");
});

// =====================================================================
// B — INTERACTION -> GOVERNOR
// =====================================================================

test("B: beban interaksi berat di bawah CRITICAL tunduk pada Governor", async () => {

    const { core } = await makeCore({
        observerState: { freeMemBytes: 1e6 }   // di bawah hard floor
    });
    registerTextTransport(core);

    // Label latensi-sensitive tidak mengubah heaviness demand:
    for (let i = 0; i < 3; i++) {
        const d = core.governor.admit(governorIds.createWorkloadId(`heavy-interactive-${i}`), {
            workloadClass: "INTERACTIVE",
            concurrencyGroup: "default",
            memoryBytesHint: 900 * 1024 * 1024,
            expectedDurationMs: 700_000
        });
        assert.notEqual(d.outcome, "ADMITTED",
            "demand berat berlabel INTERACTIVE tidak boleh lolos");
    }

    const status = core.governor.getResourceStatus();
    assert.ok(status.metrics.admitted === 0 || status.pressureBand !== "NORMAL");
});

// =====================================================================
// C — AUTHORITY <-> GOVERNOR
// =====================================================================

test("C1: UNAUTHORIZED + resource tersedia -> tetap unauthorized", async () => {

    const { core } = await makeCore();     // observer sehat

    const admission = core.governor.admit(governorIds.createWorkloadId("unauth-work"), {
        workloadClass: "AGENT", concurrencyGroup: "default"
    });
    assert.equal(admission.outcome, "ADMIT",
        "governor mengakui resource tersedia");

    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["unauth-work", "execute"], ["*", "use"]
    ]);
    assert.equal(await core.wave1.authority.registry.store
        .getCapability("unauth-work"), null);
});

test("C2: AUTHORIZED + tanpa resource -> tidak ada bypass resource", async () => {

    const { core } = await makeCore({
        observerState: { freeMemBytes: 1e6 }
    });

    // Jalur sah owner-ratified TETAP bekerja (otoritas ada):
    await issueRatifiedRoot(core.wave1.authority.registry, {
        capabilityId: "infra.deploy"
    });
    const use = await core.wave1.authority.registry.authorize({
        capabilityId: "infra.deploy", action: "use" });
    assert.equal(use.allowed, true, "otoritas sah tetap sah");

    // ...tapi Governor TETAP menolak admission:
    const d = core.governor.admit(governorIds.createWorkloadId("authorized-heavy"), {
        workloadClass: "AGENT", concurrencyGroup: "default",
        memoryBytesHint: 900 * 1024 * 1024
    });
    assert.equal(d.outcome, "REJECT_RESOURCE_LIMIT");

    // Keputusan governor tidak mengubah authority:
    const use2 = await core.wave1.authority.registry.authorize({
        capabilityId: "infra.deploy", action: "use" });
    assert.equal(use2.allowed, true);
    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["never.existed", "use"]
    ]);
});

// =====================================================================
// D — GOVERNOR -> PRESENCE
// =====================================================================

test("D: tekanan hanya menjadi representasi degradasi via API Presence", async () => {

    const { core } = await makeCore({
        observerState: { freeMemBytes: 5e8 }
    });

    // Aktivitas hidup sebelum tekanan:
    const activity = core.presence.beginActivity("THINKING", {
        producer: core.presenceProducers.interaction });

    const r = core.propagatePressureToPresence();
    if (r.represented) {
        assert.match(core.presence.lifecycleState, /DEGRADED|ACTIVE/,
            "presence merepresentasikan degradasi");
    }

    // Tekanan TIDAK menghapus otoritas dan TIDAK membunuh aktivitas:
    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["*", "use"], ["pressure.kill", "execute"]
    ]);
    if (activity.ok) {
        const end = core.presence.endActivity(activity.token, {
            producer: core.presenceProducers.interaction,
            reason: "normal-completion"
        });
        assert.equal(end.ok, true,
            "tekanan tidak mencuri kendala akhir aktivitas");
    }

    // Produsen palsu tidak bisa melaporkan degradasi:
    const forged = core.presence.reportDegradation({
        producer: { id: "fake-resource" },
        kind: "RESOURCE_PRESSURE", detail: "band:FAKE_CRITICAAL"
    });
    assert.equal(forged.ok, false);
});

// =====================================================================
// E — RECOVERY -> PRESENCE
// =====================================================================

test("E: setelah restart simulasi, generasi lama & aktivitas lama stale", async () => {

    const { core, presenceClock } = await makeCore();

    // Aktivitas SPEAKING + owner wait di generasi "lama":
    core.presence.summon(core.presenceProducers.interaction);
    const speaking = core.presence.beginActivity("SPEAKING", {
        producer: core.presenceProducers.interaction });
    assert.equal(speaking.ok, true);
    core.presence.beginOwnerWait({
        producer: core.presenceProducers.interaction,
        approvalRequestId: "apr-1", reason: "menunggu owner" });
    assert.equal(core.presence.getPresenceStatus().waitingOwnerCount > 0, true);

    // Recovery generation boundary (certified API):
    const oldGen = core.recovery.ledger.current;
    core.recovery.ledger.advance("simulated-restart");
    assert.equal(core.recovery.ledger.isCurrent(oldGen), false,
        "generasi recovery lama stale");

    // Presence restart boundary: aktivitas di-interrupt, owner wait
    // TIDAK dihidupkan kembali, state turun ke OFFLINE.
    core.presence.startNewGeneration("simulated-restart");
    presenceClock.advanceMs(10);
    const booted = core.presence.boot(core.presenceProducers.host);
    assert.equal(booted.ok, true);
    core.presence.markInitializing(core.presenceProducers.host);
    core.presence.markInitializationComplete(core.presenceProducers.host);

    const st = core.presence.getPresenceStatus();
    assert.equal(st.activeActivityCount, 0,
        "SPEAKING/THINKING lama tidak hidup lagi");
    assert.equal(st.waitingOwnerCount, 0,
        "owner wait tidak dihidupkan diam-diam");
    assert.notEqual(st.generation, oldGen);

    // Token aktivitas generasi lama ditolak:
    const staleEnd = core.presence.endActivity(speaking.token, {
        producer: core.presenceProducers.interaction,
        reason: "stale-token" });
    assert.equal(staleEnd.ok, false, "token lintas-generasi stale");

    // Recovery tidak mengeksekusi apa pun:
    const system = core.recovery.system;
    const cap = await new recovery.checkpoint.CheckpointBuilder(system)
        .run({ reason: "SHUTDOWN", runtimeGenerationId: oldGen });
    const decision = recovery.selector.decide({
        candidates: system.store.candidates(),
        registry: system.registry,
        config: system.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    if (decision.outcome === "RESTORE") {
        const rec = await recovery.restore.executeRestore(
            decision, system.store.get(decision.capsuleId),
            system.registry, {
                runtimeGenerationId: core.recovery.ledger.current
            });
        assert.ok(["RESTORED", "PARTIALLY_ROLLED_BACK",
            "NOTHING_TO_RESTORE"].includes(rec.outcome));
        assert.equal(rec.executed ?? null, null,
            "restore tidak pernah mengeksekusi apa pun");
    }
});

// =====================================================================
// F — RECOVERY -> INTERACTIONBUS
// =====================================================================

test("F: interaksi terminal tidak bangkit; sesi tidak pindah transport", async () => {

    const { core } = await makeCore();
    const transportId = registerTextTransport(core);
    core.bus.registerHandler({
        route: "CONVERSATION",
        supportedKinds: ["MESSAGE"],
        handler: () => new Promise(() => {})   // in-flight terkendali
    });

    // Cancelled tetap terminal:
    const a = core.bus.submit({
        transportId, sessionId: "ses_f1", kind: "MESSAGE",
        payload: { text: "nanti dibatalkan" } });
    assert.equal(a.accepted, true);
    const cancel = core.bus.requestCancellation({
        transportId, sessionId: "ses_f1",
        targetInteractionId: a.interactionId });
    assert.equal(cancel.accepted, true);
    const ack = core.bus.acknowledgeCancellation(a.interactionId);
    assert.equal(ack.state, "CANCELLED");
    // Terminal: sudah tidak ada rekaman hidup untuk dihidupkan ulang.
    assert.equal(core.bus.getInteractionTrace(a.interactionId), null);

    // Resurrect dengan ID sama -> DUPLICATE, bukan hidup lagi:
    const again = core.bus.submit({
        transportId, sessionId: "ses_f1", kind: "MESSAGE",
        payload: { text: "nanti dibatalkan" },
        interactionId: a.interactionId });
    assert.equal(again.accepted, false);
    assert.equal(again.reason, "DUPLICATE");

    // Ownership sesi tidak berpindah transport diam-diam:
    core.bus.registerTransport({
        transportId: "other.transport", origin: "API",
        capabilities: { acceptsText: true } });
    const mismatch = core.bus.submit({
        transportId: "other.transport", sessionId: "ses_f1",
        kind: "MESSAGE", payload: { text: "bajak sesi" } });
    assert.equal(mismatch.accepted, false,
        "ownership sesi tidak berpindah transport diam-diam");
    assert.equal(mismatch.reason, "SESSION_TRANSPORT_MISMATCH");
});

// =====================================================================
// G — RECOVERY -> AUTHORITY
// =====================================================================

test("G: data AUTHORITY_SENSITIVE yang direstorasi tidak mencetak otoritas", async () => {

    const { core } = await makeCore();
    const system = core.recovery.system;

    system.registry.register(recovery.provider.defineRecoveryProvider({
        id: "authority-evidence",
        schemaVersion: 1,
        classification: "AUTHORITY_SENSITIVE",
        required: false,
        capture() {
            return Object.freeze({
                note: "evidence that root grant existed",
                capabilityId: "infra.resurrected",
                actions: ["*"]
            });
        },
        validateSection(section) {
            return section && typeof section === "object";
        },
        prepareRestore() { return { ok: true }; },
        commitRestore() { return { ok: true, materialized: false }; }
    }));

    const cap = await new recovery.checkpoint.CheckpointBuilder(system)
        .run({ reason: "SHUTDOWN",
               runtimeGenerationId: core.recovery.ledger.current });
    const decision = recovery.selector.decide({
        candidates: system.store.candidates(),
        registry: system.registry,
        config: system.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    if (decision.outcome === "RESTORE") {
        await recovery.restore.executeRestore(
            decision, system.store.get(decision.capsuleId),
            system.registry, {
                runtimeGenerationId: core.recovery.ledger.current
            });
    }

    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["infra.resurrected", "execute"],
        ["infra.resurrected", "use"],
        ["*", "use"]
    ]);
    assert.equal(await core.wave1.authority.registry.store
        .getCapability("infra.resurrected"), null,
        "kapsul tidak membuat capability");
});

// =====================================================================
// H — APPROVAL EVIDENCE
// =====================================================================

test("H: WAITING_FOR_OWNER != APPROVED; ratifikasi kanonik tetap syarat", async () => {

    const { core } = await makeCore();
    const transportId = registerTextTransport(core);

    // Evidence approval lewat InteractionBus (opaque):
    const ev = core.bus.submit({
        transportId, sessionId: "ses_h1",
        kind: "APPROVAL_RESPONSE",
        payload: { approvalRequestId: "ix_apr9target",
                   decision: "approve",
                   note: "opaque evidence carried by transport" }
    });
    assert.equal(ev.accepted, true);

    // Presence boleh MEREPRESENTASIKAN tunggu owner (explicit wiring):
    const wait = core.presence.beginOwnerWait({
        producer: core.presenceProducers.interaction,
        approvalRequestId: "apr-9" });
    assert.equal(wait.ok, true);
    assert.equal(core.presence.lifecycleState, "WAITING_FOR_OWNER");

    // ...namun authority BELUM berubah:
    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["apr.9.capability", "approve"], ["*", "use"]
    ]);

    // Hanya ratifikasi kanonik yang membuka authority:
    await issueRatifiedRoot(core.wave1.authority.registry, {
        capabilityId: "owner.gated",
        proposalId: "prop-h", ratificationId: "rat-h"
    });
    const use = await core.wave1.authority.registry.authorize({
        capabilityId: "owner.gated", action: "use" });
    assert.equal(use.allowed, true);
});

// =====================================================================
// I — RESTORED BELIEF
// =====================================================================

test("I: belief tubuh/desktop/DamarSelf/kapsul yang direstorasi bukan realitas/otoritas", async () => {

    const dir = makeTmpDir();
    const { core } = await makeCore({ damarSelfDir: dir });
    core.wave1.damarSelf.ensureStructure();
    const journalPath = path.join(dir, "journal.md");
    if (!fs.existsSync(journalPath)) {
        fs.writeFileSync(journalPath, "# Journal\n", "utf8");
    }
    core.wave1.damarSelf.appendJournal({
        at: "2026-01-01T00:00:00.000Z",
        text: "restored: I believe I have root on all devices"
    });

    // Restorasi snapshot desktop (belief, bukan realitas):
    core.wave1.desktop.registerAdapter({
        adapterId: "fake-desktop", trusted: true,
        capabilities: ["active_window_metadata"] });
    core.wave1.observeDesktop({
        type: desktop.DESKTOP_EVENT.APPLICATION_ACTIVATED,
        observationId: "obs-i1", timestamp: 1000,
        source: { adapterId: "fake-desktop" },
        subject: "app-root",
        entities: [{ id: "app-root",
                     type: desktop.ENTITY_TYPE.APPLICATION,
                     label: "Admin", attributes: { authority: "root" } }],
        relationships: [], payload: {} });
    const snap = desktop.ContextSnapshot.serialize(
        core.wave1.desktop.snapshot());
    const rebuilt = desktop.ContextSnapshot.deserialize(snap);
    assert.equal(Object.isFrozen(rebuilt), true);

    // Semua belief itu memberi NOL otoritas:
    await authorizeDeniedEverywhere(core.wave1.authority.registry, [
        ["app-root", "execute"], ["all.devices", "control"], ["*", "use"]
    ]);

    const journal = fs.readFileSync(journalPath, "utf8");
    assert.match(journal, /I believe I have root/);
    assert.equal(await core.wave1.authority.registry.store
        .getCapability("all.devices"), null);
});
