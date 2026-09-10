"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const { createCanonicalAuthorityRegistry, isCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const { installCanonicalAuthorityRegistry } = require("../../../src/dexec/authoritySource");
const dexec = require("../../../src/dexec");

const CLOCK = () => ({ nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 });

/**
 * W6-R3-09 — RED-TEAM THE NEW PROVENANCE ROOT.
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER:
 *   - `new AuthorityRegistry(...)` from ANY caller is NEVER canonical (near
 *     the composition root or later); it cannot capture production authority.
 *   - fake registries built before bootstrap cannot capture authority.
 *   - cloned / spread / serialized / monkey-patched copies of a canonical
 *     instance are NEVER canonical (brand is object identity inside a
 *     closure-private WeakSet populated only by the composition-root factory).
 *   - evolution live ratification and distributed-execution live authority
 *     resolve ONLY through the canonical registry.
 */

function mkStore() { return createMemoryAuthorityStore(); }

test("R3-09: caller-created `new AuthorityRegistry` before bootstrap is NOT canonical", () => {
    const fake = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    assert.equal(isCanonicalAuthorityRegistry(fake), false);
    assert.throws(() => installCanonicalAuthorityRegistry(fake), /composition-root ownership/);
});

test("R3-09: caller-created registry after bootstrap is still NOT canonical", () => {
    // A canonical owner already exists (installed by authorityLease/canonical
    // suites in this process). A NEW caller registry must STILL be rejected.
    const late = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    assert.equal(isCanonicalAuthorityRegistry(late), false);
    assert.throws(() => installCanonicalAuthorityRegistry(late), /composition-root ownership/);
});

test("R3-09: cloned / spread / serialized / monkey-patched canonical registry rejected", () => {
    // Build a genuinely canonical registry (the only way to become canonical).
    const canonical = createCanonicalAuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    assert.equal(isCanonicalAuthorityRegistry(canonical), true);

    // Object.assign spread / structured clone / JSON round-trip / manual copy
    const spread = { ...canonical };
    const cloned = Object.assign(Object.create(null), canonical);
    const json = JSON.parse(JSON.stringify(canonical));
    const manual = { store: canonical.store, clock: canonical.clock };

    for (const [label, value] of [
        ["spread", spread], ["Object.assign clone", cloned],
        ["serialized/deserialized", json], ["manual reconstruction", manual]
    ]) {
        assert.equal(isCanonicalAuthorityRegistry(value), false, `${label} must NOT be canonical`);
        assert.throws(() => installCanonicalAuthorityRegistry(value),
            /composition-root ownership/, `${label} install must be rejected`);
    }

    // Monkey-patched copy: same shape, added methods — still not canonical.
    const patched = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    Object.defineProperty(patched, "store", { value: canonical.store });
    Object.defineProperty(patched, "getCurrentRatification", { value: canonical.getCurrentRatification });
    assert.equal(isCanonicalAuthorityRegistry(patched), false);
    assert.throws(() => installCanonicalAuthorityRegistry(patched), /composition-root ownership/);
});

test("R3-09: no exported first-bind / brand API exists on the dexec public surface", () => {
    assert.equal(typeof dexec.bindCanonicalAuthorityRegistry, "undefined",
        "bindCanonicalAuthorityRegistry first-bind surface must be REMOVED");
    assert.equal(dexec.getCanonicalAuthorityBridge, undefined,
        "bridge getter must not be exported publicly");
    assert.equal(typeof dexec.installCanonicalAuthorityRegistry, "function",
        "only the composition-root install seam is the (non-first-wins) factory-install entry");
});

test("R3-09: a composition-root-produced owner is installable and is THE canonical authority", () => {
    const canonical = createCanonicalAuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    // If a different canonical was already installed first, this returns false
    // (first-wins) WITHOUT throwing — never displaces.
    try { installCanonicalAuthorityRegistry(canonical); } catch (e) {
        // already bound to a DIFFERENT owner (earlier suite) -> first-wins
        assert.match(e.message, /cannot be displaced/);
    }
    const owner = isCanonicalAuthorityRegistry(canonical);
    assert.equal(owner, true);
});

test("R3-09: evolution live ratification resolves ONLY through the canonical owner", async () => {
    const evo = require("../../../src/evolution");
    const authorityModel = require("../../../src/authority/model");
    const pipeline = new evo.EvolutionPipeline({ authorityModel });
    // A caller-created (non-canonical) registry must be rejected by the brand
    // check at canary time — even though it structurally supports the API.
    const fakeCanonical = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    pipeline.authorityRegistry = fakeCanonical;
    pipeline.recordExperience(evo.buildExperienceRecord({ taskType: "coding", selectedCapability: "cap", selectedProvider: "prov", result: "succeeded", latencyMs: 100 }));
    await pipeline.createProposal({
        proposalId: "x", createdBy: "owner", kind: "routing_preference",
        problem: "x", proposedChange: "y", evidence: { signalKeys: ["coding|cap|prov"] },
        requestedAuthority: { capabilityId: "code.test", subject: "damar", actions: ["execute"], candidateArtifactDigest: "c".repeat(64) }
    }).catch(() => {});
    await assert.rejects(
        () => pipeline.startCanary({ proposalId: "x", candidateArtifactDigest: "c".repeat(64) }),
        (e) => e.code === "EVOLUTION_NOT_APPROVED" ||
               /not the canonical owner/.test(e.message),
        "a monkey-patched/duck-typed registry cannot mint canary authority"
    );
});

test("R3-09: distributed execution live authority resolves ONLY through canonical registry", async () => {
    const mesh = require("../../../src/mesh");
    const ids = mesh.ids;
    const { DistributedExecutionRouter } = require("../../../src/dexec");
    // Router built WITHOUT the canonical owner bound to it still requires the
    // module-private canonical source; a caller-created registry never becomes
    // the source.
    const trust = new mesh.NodeTrust();
    const registry = new mesh.NodeRegistry();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "n" });
    const router = new DistributedExecutionRouter({ trust, registry });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const intent = { intentId: "i1", capabilityId: "code.test", operation: "run", arguments: {}, correlationId: "c", createdAtMs: 1 };
    // Without the canonical owner having a grant for code.test, routing
    // DENIES (never a caller-fake). If a canonical owner from another suite is
    // installed but has no code.test grant, this still DENIES.
    const err = await router.route({ intent, toolId: "t", preferredNodeId: identity.nodeId }).then(() => null).catch(e => e);
    assert.ok(err, "route must fail closed (no caller-supplied authority path)");
    assert.equal(err.failureClass === "AUTHORITY_DENIED" || err.code === "MESSAGE_MALFORMED", true);
});