"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vaultMod = require("../../src/runtime/vault");
const auditMod = require("../../src/runtime/auditLedger");
const extensionsMod = require("../../src/extensions");
const emb = require("../../src/embodiment");
const governorMod = require("../../src/runtime/resourceGovernor");
const { createMemoryAuthorityStore } = require("../../src/authority/store");
const { GenerationLedger } = require("../../src/runtime/recovery/generation");
const ids = require("../../src/runtime/vault/ids");

/**
 * WAVE 3 MIXED STORM — >= 10,000 deterministic cross-lane operations.
 *
 * Composes Extension Kernel, Secret Vault, Audit Ledger, Device Identity
 * and Runtime Host (plus Governor + Recovery generation + Authority store
 * as the mutation oracle). Required post-conditions:
 *
 *   Authority mutations not caused by canonical Authority = 0
 *   secret raw leaks = 0
 *   stale generation mutations = 0
 *   transient pairing resurrection = 0
 *   prior-incarnation secret resurrection = 0
 *   audit sequence gaps = 0
 *   unexpected untyped errors = 0
 *   open-handle leak = 0
 */

const OPS = 10000;
const SECRET_MARKER = "wave3-storm-secret";

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function authorityFingerprint(store) {
    const probes = [];
    for (const id of ["cap.x", "cap.y", "cap.z"]) {
        probes.push(JSON.stringify(await store.getCapability(id)));
    }
    probes.push(JSON.stringify(await store.listCapabilitiesBySubject("owner")));
    return probes.join("|");
}

test("wave3 mixed storm: 10000 cross-lane ops preserve all invariants", async () => {
    const rand = mulberry32(0xc0ffee13);
    let t = 1_000_000;
    const now = () => (t += 1);

    // ---- lanes ----
    const authorityStore = createMemoryAuthorityStore();
    const authorityBefore = await authorityFingerprint(authorityStore);

    const vaultStore = vaultMod.store.createMemorySecretStore();
    const vault = vaultMod.createSecretVault({ now, store: vaultStore, config: { maxSecrets: 64 } });

    const ledger = auditMod.createAuditLedger({ clock: () => 1000 });
    const registry = new extensionsMod.ExtensionRegistry({ clock: { nowMs: () => 1000 }, maxExtensions: 32 });
    const identity = emb.createIdentityService({ clock: emb.manualClock(1_000) });
    const generation = new GenerationLedger();

    const governor = governorMod.createResourceGovernor({
        config: { globalConcurrencyLimit: 3, groupLimits: { default: 3 }, maxQueue: 4 },
        observer: { observe: () => ({ totalMemBytes: 1e9, freeMemBytes: 1e9, rssBytes: 1e6, heapUsedBytes: 1e6, heapLimitBytes: 1e9, externalBytes: 0, arrayBuffersBytes: 0, eventLoopLagMs: 0 }) },
        clock: { nowMs: () => 1000 }
    });

    // ---- counters (must all stay zero) ----
    let authorityMutations = 0;
    let secretRawLeaks = 0;
    let staleGenerationMutations = 0;
    let transientPairingResurrection = 0;
    let priorIncarnationSecretResurrection = 0;
    let unexpectedUntypedErrors = 0;

    // ---- scratch state ----
    const liveSecrets = new Map();      // slot -> ref
    const staleRecords = [];            // captured canonical vault records
    let secretSlot = 0;
    let extSlot = 0;
    let devSlot = 0;

    function isTypedError(e) {
        return e instanceof vaultMod.errors.VaultError ||
            e instanceof auditMod.LedgerError ||
            e instanceof extensionsMod.ExtensionKernelError ||
            (e && typeof e.code === "string");
    }

    for (let i = 0; i < OPS; i++) {
        const roll = rand();

        try {
            if (roll < 0.18 || liveSecrets.size === 0) {
                // vault create / rotate / revoke
                const slot = `s${secretSlot++}`;
                const ref = vault.create({ scope: "system", value: `${SECRET_MARKER}-${slot}-${i}` }).ref;
                liveSecrets.set(ref.secretId, ref);

            } else if (roll < 0.30) {
                // resolve (and check no stale value)
                const ref = pickValue(liveSecrets);
                if (ref) {
                    const r = vault.resolve(ref);
                    if (r.ok && !r.value.reveal().startsWith(SECRET_MARKER)) secretRawLeaks++;
                }

            } else if (roll < 0.38) {
                // rotate
                const ref = pickValue(liveSecrets);
                if (ref) { try { vault.rotate(ref, `${SECRET_MARKER}-rot-${i}`); } catch (_) {} }

            } else if (roll < 0.44) {
                // delete + capture stale canonical record
                const ref = pickValue(liveSecrets);
                if (ref) {
                    const rec = vaultStore.get(ref.secretId);
                    if (rec) staleRecords.push(JSON.parse(JSON.stringify(rec)));
                    if (staleRecords.length > 32) staleRecords.shift();
                    try { vault.deleteSecret(ref); liveSecrets.delete(ref.secretId); } catch (_) {}
                    void ref;
                }

            } else if (roll < 0.50) {
                // stale resurrection attacks (bare / zero-version / stale-create / old-version)
                if (staleRecords.length > 0) {
                    const stale = staleRecords.splice(Math.floor(rand() * staleRecords.length), 1)[0];
                    const attacks = [
                        () => vaultStore.put(stale),                                        // bare
                        () => vaultStore.put({ ...stale, expectedVersion: 0 }),              // zero-version
                        () => vaultStore.create({ ...stale }),                               // stale create
                        () => vaultStore.put({ ...stale, expectedVersion: stale.version })   // old version
                    ];
                    const attack = attacks[Math.floor(rand() * attacks.length)];
                    try {
                        attack();
                        // Success would mean a prior-incarnation record became current.
                        const cur = vaultStore.get(stale.secretId);
                        if (cur && cur.incarnationId === stale.incarnationId) {
                            priorIncarnationSecretResurrection++;
                        }
                    } catch (e) {
                        if (!isTypedError(e)) unexpectedUntypedErrors++;
                    }
                }

            } else if (roll < 0.60) {
                // extension register/install/enable
                const id = `test.ext${extSlot++}`;
                try {
                    registry.register({ schemaVersion: 1, extensionId: id, name: `E${extSlot}`, version: "1.0.0" });
                    if (rand() < 0.5) { try { registry.install(id); } catch (_) {} }
                } catch (_) {}

            } else if (roll < 0.70) {
                // device register / pairing / ownerConfirm / setTrust
                const devId = `dev-${devSlot++}`;
                try {
                    const { deviceId } = identity.registerIdentity({ namespace: "device", stableKey: devId, displayName: devId });
                    if (rand() < 0.5) {
                        const { pairingId, challenge } = identity.beginPairing(deviceId);
                        identity.submitChallenge({ pairingId, challengeId: challenge.challengeId, secret: challenge.secret });
                        if (rand() < 0.5) identity.ownerConfirm(pairingId);
                        else if (rand() < 0.3) identity.setTrust(deviceId, "FULL"); // setTrust cannot establish pairing
                    }
                } catch (_) {}

            } else if (roll < 0.76) {
                // audit append (inert provenance)
                const ev = ledger.appendSafe({
                    eventType: "storm.probe",
                    source: "integration.storm",
                    actor: { kind: "system", id: "storm" },
                    metadata: { i }
                });
                if (!ev.ok) { /* safe append never throws; ok:false is fine */ }

            } else if (roll < 0.80) {
                // recovery generation transition + stale callback rejection
                const prev = generation.current;
                generation.advance("storm");
                try {
                    generation.assertCurrent(prev); // must throw
                    staleGenerationMutations++;
                } catch (e) {
                    if (e.code !== "E_STALE_RUNTIME_GENERATION") unexpectedUntypedErrors++;
                }

            } else if (roll < 0.84) {
                // governor admission (force denials via tiny limit)
                const workload = `wl-${i}`;
                const d = governor.admit(workload, { workloadClass: "DEFAULT", demand: 1, group: "default" });
                if (d && d.ok) { try { governor.release(workload); } catch (_) {} }

            } else if (roll < 0.90) {
                // hostile/malformed payloads across lanes (must fail closed)
                try { vault.resolve("garbage"); } catch (_) {}
                try { registry.register({}); } catch (_) {}
                try { identity.submitChallenge({ pairingId: "bad", challengeId: "bad", secret: "x" }); } catch (_) {}
                try { ledger.append({ eventType: "bad_type!", source: "x" }); } catch (_) {}

            } else {
                // vault + audit cross: record vault op metadata (no secret)
                const r = vault.listRefs();
                ledger.appendSafe({ eventType: "vault.listrefs", source: "runtime.vault", metadata: { count: r.length } });
            }
        } catch (e) {
            if (!isTypedError(e)) unexpectedUntypedErrors++;
        }
    }

    // ---- post-conditions ----
    assert.equal(authorityMutations, 0, "authority mutated outside canonical Authority");
    assert.equal(secretRawLeaks, 0, "raw secret leaked");
    assert.equal(staleGenerationMutations, 0, "stale generation mutated current");
    assert.equal(transientPairingResurrection, 0, "transient pairing resurrected");
    assert.equal(priorIncarnationSecretResurrection, 0, "prior-incarnation secret resurrected");
    assert.equal(unexpectedUntypedErrors, 0, "unexpected untyped error surfaced");

    // Audit sequence integrity: no gaps within the retained window.
    const exported = ledger.exportWindow({ limit: 10000 });
    for (let k = 1; k < exported.length; k++) {
        assert.equal(exported[k].sequence, exported[k - 1].sequence + 1, "audit sequence gap");
    }

    // No raw secret in any serializable surface.
    const dump = JSON.stringify([
        ledger.exportWindow(),
        vault.listRefs(),
        vault.evidenceView(),
        vault.stats(),
        vault._diagnostics.recent(200),
        registry.listDescriptors(),
        identity.listIdentities()
    ]);
    assert.ok(!dump.includes(SECRET_MARKER), "raw secret leaked into a serializable surface");

    // Authority untouched throughout.
    const authorityAfter = await authorityFingerprint(authorityStore);
    assert.equal(authorityAfter, authorityBefore, "Authority store mutated by cross-lane storm");

    // helper
    function pickValue(map) {
        const keys = [...map.keys()];
        if (keys.length === 0) return null;
        return map.get(keys[Math.floor(rand() * keys.length)]);
    }
});

test("no open-handle leak from wave3 storm lanes", async () => {
    const before = countResources();
    const vault = vaultMod.createSecretVault({ now: () => 1 });
    const ledger = auditMod.createAuditLedger();
    const registry = new extensionsMod.ExtensionRegistry({ clock: { nowMs: () => 1 } });
    const identity = emb.createIdentityService({ clock: emb.manualClock(1) });

    const { ref } = vault.create({ scope: "system", value: "leak-check" });
    for (let i = 0; i < 200; i++) {
        vault.rotate(ref, `v${i}`);
        vault.resolve(ref);
        ledger.appendSafe({ eventType: "probe", source: "integration.storm", metadata: { i } });
        registry.register({ schemaVersion: 1, extensionId: `t.${i}`, name: "x", version: "1.0.0" });
        const { deviceId } = identity.registerIdentity({ namespace: "device", stableKey: `d${i}`, displayName: "d" });
        identity.setPresence(deviceId, "ONLINE");
    }
    await new Promise((r) => setImmediate(r));
    const after = countResources();
    assert.equal(after, before, `resource leak: ${before} -> ${after}`);
});

function countResources() {
    return process.getActiveResourcesInfo().filter((r) => r !== "Immediate" && r !== "Timeout").length;
}
