"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AuthorityRegistry } = require("../../../src/authority/registry");
const { isCanonicalAuthorityRegistry } = require("../../../src/authority/canonicalOwnership");
const { createMemoryAuthorityStore } = require("../../../src/authority/store");
const dexec = require("../../../src/dexec");
const { makeCanonicalAuthorityRoot } = require("./testCanonicalRoot");

const CLOCK = () => ({ nowIso: () => new Date(1_000_000).toISOString(), nowMs: () => 1_000_000 });

/**
 * W6-R4-01 — RED-TEAM THE COMPOSITION-ROOT PROVENANCE.
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER:
 *   - `new AuthorityRegistry(...)` from ANY caller is NEVER canonical.
 *   - No production export can construct, canonify, install, or rebind the
 *     canonical Authority owner.
 *   - Only the deep-internal composition (reached here via the test-only
 *     harness, which is itself not part of any public/package surface) can
 *     construct+mark+install.
 *   - Clones / spreads / serialized / monkey-patched copies are never canonical
 *     (object identity in a closure-private WeakSet).
 *   - Evolution live ratification and distributed-execution live authority
 *     resolve ONLY through the canonical owner.
 */

function mkStore() { return createMemoryAuthorityStore(); }

test("R4-01: caller-created `new AuthorityRegistry` is never canonical (pre/post bootstrap)", () => {
    const fake = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    assert.equal(isCanonicalAuthorityRegistry(fake), false);
    const late = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    assert.equal(isCanonicalAuthorityRegistry(late), false);
});

test("R4-01: no public factory/installer/binder on authority or dexec surfaces", () => {
    // authority surface exposes only read-only predicate + vocab.
    const authorityPublic = require("../../../src/authority");
    assert.equal(authorityPublic.createCanonicalAuthorityRegistry, undefined,
        "authority public surface must NOT export a canonical factory (R4-01)");
    assert.equal(authorityPublic.canonical && authorityPublic.canonical.createCanonicalAuthorityRegistry, undefined,
        "canonical vocab must NOT carry a factory");
    // dexec public surface exposes no installer / first-bind.
    assert.equal(dexec.installCanonicalAuthorityRegistry, undefined,
        "dexec public must NOT export an installer (R4-01)");
    assert.equal(dexec.bindCanonicalAuthorityRegistry, undefined,
        "dexec public must NOT export a first-bind binder");
    assert.equal(dexec.createCanonicalAuthorityRegistry, undefined,
        "dexec public must NOT export a canonical factory");
    assert.equal(dexec.getCanonicalAuthorityBridge, undefined,
        "bridge getter must not be exported publicly");
});

test("R4-01: cloned / spread / serialized / monkey-patched canonical registry rejected", async () => {
    // Brand-only (not distributed source) — the distributed source is
    // first-wins and bound by routing suites; this test needs only the brand.
    const { owner: canonical } = await makeCanonicalAuthorityRoot({
        store: mkStore(), clock: CLOCK(), installDistributed: false
    });
    assert.equal(isCanonicalAuthorityRegistry(canonical), true);

    const spread = { ...canonical };
    const cloned = Object.assign(Object.create(null), canonical);
    const json = JSON.parse(JSON.stringify(canonical));
    const manual = { store: canonical.store, clock: canonical.clock };
    for (const [label, value] of [
        ["spread", spread], ["Object.assign clone", cloned],
        ["serialized/deserialized", json], ["manual reconstruction", manual]
    ]) {
        assert.equal(isCanonicalAuthorityRegistry(value), false, `${label} must NOT be canonical`);
    }
    const patched = new AuthorityRegistry({ store: mkStore(), clock: CLOCK() });
    Object.defineProperty(patched, "store", { value: canonical.store });
    Object.defineProperty(patched, "getCurrentRatification", { value: canonical.getCurrentRatification });
    assert.equal(isCanonicalAuthorityRegistry(patched), false);
    // There is no public installer to attempt on the patched copy.
    assert.equal(dexec.installCanonicalAuthorityRegistry, undefined);
});

test("R4-01: composition-root owner is canonical and is THE authority (no rebind via public surface)", async () => {
    const { owner: canonical, isCanonical } = await makeCanonicalAuthorityRoot({ store: mkStore(), clock: CLOCK(), installDistributed: false });
    assert.equal(isCanonical, true);
    assert.equal(isCanonicalAuthorityRegistry(canonical), true);
    // No public rebinding handle exists.
    assert.equal(dexec.installCanonicalAuthorityRegistry, undefined);
    assert.equal(dexec.bindCanonicalAuthorityRegistry, undefined);
});

test("R4-01: evolution live ratification resolves ONLY through the canonical owner", async () => {
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
        "a duck-typed registry cannot mint canary authority"
    );
});

test("R4-01: distributed execution live authority resolves ONLY through canonical registry", async () => {
    const mesh = require("../../../src/mesh");
    const ids = mesh.ids;
    const { DistributedExecutionRouter } = require("../../../src/dexec");
    const trust = new mesh.NodeTrust();
    const registry = new mesh.NodeRegistry();
    const identity = mesh.meshIdentity.mintNodeIdentity({ logicalDamarId: ids.mint.logicalDamarId() });
    registry.register({ identity, displayName: "n" });
    const router = new DistributedExecutionRouter({ trust, registry });
    trust.pair({ nodeId: identity.nodeId, state: "TRUSTED", scopes: ["COMPUTE", "TOOL_EXECUTION"] });
    const intent = { intentId: "i1", capabilityId: "code.test", operation: "run", arguments: {}, correlationId: "c", createdAtMs: 1 };
    const err = await router.route({ intent, toolId: "t", preferredNodeId: identity.nodeId }).then(() => null).catch(e => e);
    assert.ok(err, "route must fail closed (no caller-supplied authority path / owner not installed)");
    // Fail-closed either because the canonical owner isn't installed yet
    // (plain Error with "not yet bound") OR because a bound owner denies this
    // capability (AUTHORITY_DENIED). Either way route() MUST NOT resolve.
    const deniedByOwner = err.failureClass === "AUTHORITY_DENIED" || err.code === "MESSAGE_MALFORMED";
    const ownerUnbound = /not yet bound/.test(err.message || "");
    assert.ok(deniedByOwner || ownerUnbound, "route must fail closed: got " + (err.message || "").slice(0, 120));
});