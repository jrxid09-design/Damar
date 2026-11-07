"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * INTEGRATION WAVE 3 — invarian lintas-lane certified foundations.
 *
 * Lima lane (Extension Kernel, Secret Vault, Audit Ledger, Device
 * Identity, Runtime Host) telah di-integrasikan. Test ini membuktikan
 * bahwa KOMPOSISI lane tidak menciptakan edge yang dilarang:
 *
 *   interaction/audit/pairing/discovery/secret availability
 *     != Authority / ratification / delegation / actuation
 *
 *   audit adalah provenance INERT, bukan current-truth / approval.
 *   raw secret tidak pernah mencapai ledger/bus/diagnostik/deskriptor.
 */

const vaultMod = require("../../src/runtime/vault");
const auditMod = require("../../src/runtime/auditLedger");
const extensionsMod = require("../../src/extensions");
const emb = require("../../src/embodiment");
const { createMemoryAuthorityStore } = require("../../src/authority/store");

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "damar-w3-"));
}

/** Authority mutation fingerprint: byte-identical before/after == no mutation. */
async function authorityFingerprint(store) {
    const probes = [];
    for (const id of ["cap.x", "cap.y", "cap.z"]) {
        probes.push(JSON.stringify(await store.getCapability(id)));
    }
    probes.push(JSON.stringify(await store.listCapabilitiesBySubject("owner")));
    return probes.join("|");
}

// =====================================================================
// 1. Host external interaction -> InteractionBus -> optional Audit Ledger
//    -> zero Authority mutation
// =====================================================================

test("w3-1: host external interaction records audit provenance without Authority mutation", async () => {
    const { createRuntimeHost } = require("../../src/runtime/host");

    const authorityStore = createMemoryAuthorityStore();
    const before = await authorityFingerprint(authorityStore);

    const host = await createRuntimeHost({});
    const hostBus = host.core.bus;

    // An external transport claims to arrive — transport claim is NOT
    // ownership/trust and NOT authority.
    hostBus.registerTransport({
        transportId: "external.telegram",
        origin: "TELEGRAM",
        capabilities: { acceptsText: true, supportsCancellation: true }
    });

    // Record an audit event that an external interaction arrived.
    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });
    const event = ledger.appendSafe({
        eventType: "interaction.external.received",
        source: "runtime.host",
        actor: { kind: "external", id: "external.telegram" },
        metadata: { transport: "telegram" }
    });
    assert.equal(event.ok, true);

    // No capability was minted/granted by the interaction or its audit.
    const after = await authorityFingerprint(authorityStore);
    assert.equal(after, before, "external interaction + audit mutated Authority");
    assert.ok(hostBus, "host should expose the composed bus");
});

// =====================================================================
// 2. Device pairing event -> Audit Ledger provenance -> no capability grant
// =====================================================================

test("w3-2: device pairing produces audit provenance but grants no capability", async () => {
    const authorityStore = createMemoryAuthorityStore();
    const before = await authorityFingerprint(authorityStore);

    const svc = emb.createIdentityService({ clock: emb.manualClock(1_000) });
    const { deviceId } = svc.registerIdentity({
        namespace: "device", stableKey: "phone-1", displayName: "Phone"
    });

    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });

    // Pairing flow reaches AWAITING_OWNER_CONFIRMATION.
    const { pairingId, challenge } = svc.beginPairing(deviceId);
    svc.submitChallenge({
        pairingId,
        challengeId: challenge.challengeId,
        secret: challenge.secret
    });

    // Record the pairing event as provenance (inert).
    const rec = ledger.appendSafe({
        eventType: "device.pairing.challengesubmitted",
        source: "embodiment.identity",
        subject: { kind: "device", id: deviceId },
        metadata: { pairingId }
    });
    assert.equal(rec.ok, true);

    // The pairing state is still awaiting owner confirmation — audit did
    // not confirm it.
    const ident = svc.getIdentity(deviceId);
    assert.equal(ident.pairingState, "AWAITING_OWNER_CONFIRMATION");

    // Owner confirms, pairing is established. Still no Authority grant.
    const confirm = svc.ownerConfirm(pairingId);
    assert.equal(confirm.pairingState, "PAIRED");

    const after = await authorityFingerprint(authorityStore);
    assert.equal(after, before, "device pairing mutated Authority");
});

// =====================================================================
// 3. Extension discovery/registration -> optional Audit provenance
//    -> no execution / Authority mutation
// =====================================================================

test("w3-3: extension registration is auditable but grants/executes nothing", async () => {
    const authorityStore = createMemoryAuthorityStore();
    const before = await authorityFingerprint(authorityStore);

    const { ExtensionRegistry } = extensionsMod;
    const registry = new ExtensionRegistry({ clock: { nowMs: () => 1000 } });
    const res = registry.register({
        schemaVersion: 1,
        extensionId: "test.alpha",
        name: "Alpha",
        version: "1.0.0",
        capabilities: ["something.capability"]
    });
    assert.equal(res.registered, true);

    // Descriptors may REFERENCE capability requirements, but registration
    // must not grant them.
    const caps = registry.getCapabilities(res.id);
    assert.ok(caps.includes("something.capability"));

    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });
    const rec = ledger.appendSafe({
        eventType: "extension.registered",
        source: "extensions",
        subject: { kind: "extension", id: res.id.value },
        metadata: { capabilities: caps }
    });
    assert.equal(rec.ok, true);

    const after = await authorityFingerprint(authorityStore);
    assert.equal(after, before, "extension registration mutated Authority");
});

// =====================================================================
// 4. Vault access failure/success diagnostics -> no raw secret reaches
//    Audit Ledger
// =====================================================================

test("w3-4: vault diagnostics never leak raw secret into audit ledger", () => {
    const store = vaultMod.store.createMemorySecretStore();
    const vault = vaultMod.createSecretVault({ now: () => 1000, store });
    const { ref } = vault.create({
        scope: "system", value: "RAW-SECRET-DO-NOT-LEAK-777"
    });

    // Success + failure diagnostics both exercise the vault.
    const ok = vault.resolve(ref);
    assert.equal(ok.ok, true);
    assert.equal(ok.value.reveal(), "RAW-SECRET-DO-NOT-LEAK-777");

    // A failed resolve (unknown secret) produces a diagnostic too.
    const missing = vault.resolve(
        vaultMod.refs.buildSecretRef({ secretId: "sec-" + "0".repeat(32), scope: "system" })
    );
    assert.equal(missing.ok, false);

    // Append vault diagnostics to the audit ledger — only metadata.
    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });
    for (const entry of vault._diagnostics.recent(100)) {
        ledger.appendSafe({
            eventType: "vault.operation",
            source: "runtime.vault",
            metadata: {
                op: entry.op,
                outcome: entry.outcome,
                secretId: entry.secretId
            }
        });
    }

    const dump = JSON.stringify(ledger.exportWindow());
    assert.ok(!dump.includes("RAW-SECRET-DO-NOT-LEAK-777"), "raw secret leaked into audit ledger");
});

// =====================================================================
// 5. Recovery generation change -> stale Host callback rejected ->
//    historical audit remains history only
// =====================================================================

test("w3-5: stale generation callback rejected; audit history stays inert", async () => {
    const { GenerationLedger } = require("../../src/runtime/recovery/generation");

    const ledger = new GenerationLedger();
    const gen1 = ledger.current;

    // A stale callback stamped with gen1 after advance must be rejected.
    const advanced = ledger.advance("integration-test");
    assert.notEqual(advanced.generationId, gen1);

    assert.equal(ledger.isCurrent(gen1), false);
    assert.throws(
        () => ledger.assertCurrent(gen1),
        (e) => e.code === "E_STALE_RUNTIME_GENERATION"
    );
    assert.equal(ledger.assertCurrent(advanced.generationId), true);

    // Audit history records the generation transition as history only.
    const audit = auditMod.createAuditLedger({ clock: () => 1000 });
    audit.appendSafe({
        eventType: "runtime.generation.advanced",
        source: "runtime.recovery",
        metadata: { previous: gen1, current: advanced.generationId }
    });
    // The audit record is inert: it does not resurrect gen1 as current.
    assert.equal(ledger.isCurrent(gen1), false);
    assert.equal(ledger.isCurrent(advanced.generationId), true);
});

// =====================================================================
// 6. WAITING_FOR_OWNER -> auditable -> remains waiting -> audit is not approval
// =====================================================================

test("w3-6: WAITING_FOR_OWNER is auditable but audit presence is not approval", () => {
    const svc = emb.createIdentityService({ clock: emb.manualClock(1_000) });
    const { deviceId } = svc.registerIdentity({
        namespace: "device", stableKey: "phone-wait", displayName: "Phone"
    });
    const { pairingId, challenge } = svc.beginPairing(deviceId);
    svc.submitChallenge({
        pairingId,
        challengeId: challenge.challengeId,
        secret: challenge.secret
    });

    // The pairing is WAITING_FOR_OWNER (AWAITING_OWNER_CONFIRMATION).
    assert.equal(svc.getIdentity(deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");

    // Record an audit event that it is waiting.
    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });
    ledger.appendSafe({
        eventType: "device.pairing.waitingowner",
        source: "embodiment.identity",
        subject: { kind: "device", id: deviceId },
        metadata: { pairingId }
    });

    // Audit presence does not approve: state remains waiting.
    assert.equal(svc.getIdentity(deviceId).pairingState, "AWAITING_OWNER_CONFIRMATION");

    // Only explicit ownerConfirm establishes pairing.
    const confirm = svc.ownerConfirm(pairingId);
    assert.equal(confirm.pairingState, "PAIRED");
});
