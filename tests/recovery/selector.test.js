"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const selector = require("../../src/runtime/recovery/selector");
const ids = require("../../src/runtime/recovery/ids");

function setup() {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc", data: { seq: 1 } }));
    return s;
}

test("selector: explicit capsule selection yields RESTORE", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.RESTORE);
    assert.equal(d.capsuleId, cap.manifest.capsuleId);
});

test("selector: implicit newest-wins refused by default (no silent trust of latest file)", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const d = selector.decide({ candidates: [cap], registry: s.registry, config: s.config });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["SELECTION_AMBIGUOUS"]);
});

test("selector: explicit id not present refuses with exact reason", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: ids.newRecoveryCapsuleId()
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["EXPLICIT_SELECTION_NOT_FOUND"]);
});

test("selector: NEWEST_VALID policy picks newest valid candidate deterministically", async () => {
    const s = setup();
    const older = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const newer = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    assert.ok(older.manifest.epochId < newer.manifest.epochId);
    const dShuffled = selector.decide({
        candidates: [newer, older],
        registry: s.registry,
        config: s.config,
        policy: "NEWEST_VALID"
    });
    const dOtherOrder = selector.decide({
        candidates: [older, newer],
        registry: s.registry,
        config: s.config,
        policy: "NEWEST_VALID"
    });
    assert.equal(dShuffled.capsuleId, newer.manifest.capsuleId);
    assert.equal(JSON.stringify(dShuffled), JSON.stringify(dOtherOrder));
});

test("selector: missing OPTIONAL section -> DEGRADED_RESTORE naming exactly what degraded", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc", data: {} }));
    s.registry.register(
        makeFakeProvider({
            id: "sensorium",
            classification: "PUBLIC_STATE",
            required: false,
            capture: () => null
        })
    );
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    assert.ok(!cap.manifest.sections.some((x) => x.sectionId === "sensorium"));
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.DEGRADED_RESTORE);
    assert.deepEqual([...d.degradedSections], ["sensorium"]);
    assert.ok(d.reasonCodes.includes("DEGRADED_MISSING_OPTIONAL_SECTIONS"));
});

test("selector: missing REQUIRED section -> REFUSE with explicit reason", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    s.registry.register(makeFakeProvider({ id: "governor", required: true }));
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["MISSING_REQUIRED_SECTION"]);
});

test("selector: unsupported schema version -> REFUSE UNSUPPORTED_VERSION", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    // subsystem upgraded to v2 after checkpoint; new registry expects v2
    const upgraded = makeSystem();
    upgraded.registry.register(makeFakeProvider({ id: "acc", schemaVersion: 2, data: { seq: 1 } }));
    const d = selector.decide({
        candidates: [cap],
        registry: upgraded.registry,
        config: upgraded.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["UNSUPPORTED_VERSION"]);
});

test("selector: incomplete/invalid candidate refused fail-closed under NEWEST_VALID too", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const broken = JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections }));
    broken.manifest.status = "BUILDING";
    const d = selector.decide({
        candidates: [broken],
        registry: s.registry,
        config: s.config,
        policy: "NEWEST_VALID"
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["INCOMPLETE_CAPSULE"]);
});

test("selector: AUTHORITY_SENSITIVE section -> opaque; decision demands revalidation, never interprets", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "authority", classification: "AUTHORITY_SENSITIVE", required: false, data: { grants: [] } }));
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.ok(d.requiresAuthorityRevalidation);
    assert.ok(d.reasonCodes.includes("AUTHORITY_REVALIDATION_REQUIRED"));
    assert.ok(d.deferredSections.some((x) => x.sectionId === "authority" && x.status === "REQUIRES_REVALIDATION"));
});

test("selector: NON_RESUMABLE section deferred as INTERRUPTED, never auto-resumed", async () => {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "actuation", classification: "NON_RESUMABLE", required: false, data: { cmd: "half-typed" } }));
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const d = selector.decide({
        candidates: [cap],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.deepEqual(d.deferredSections, [{ sectionId: "actuation", status: "INTERRUPTED" }]);
    assert.ok(d.reasonCodes.includes("NON_RESUMABLE_STATE_DEFERRED"));
});

test("selector: candidate list bounded by config", async () => {
    const s = setup();
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const many = Array.from({ length: 50 }, () => cap);
    const d = selector.decide({
        candidates: many,
        registry: s.registry,
        config: makeSystem({ maxCandidateCapsules: 4 }).config,
        requestedCapsuleId: cap.manifest.capsuleId
    });
    assert.notEqual(d.outcome, undefined);
});

async function buildForkedCandidates() {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc", data: { seq: 1 } }));
    const build = (parentCapsuleId = null) =>
        new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current, parentCapsuleId });
    const root = await build();
    const child1 = await build(root.manifest.capsuleId);
    const child2 = await build(root.manifest.capsuleId);
    return { s, root, child1, child2 };
}

test("selector: NEWEST_VALID refuses on LINEAGE_FORK instead of silently choosing a branch", async () => {
    const { s, root, child1, child2 } = await buildForkedCandidates();
    const dNewest = selector.decide({ candidates: [root, child1, child2], registry: s.registry, config: s.config, policy: "NEWEST_VALID" });
    assert.equal(dNewest.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(dNewest.reasonCodes, ["LINEAGE_FORK"]);
    assert.ok(dNewest.diagnostics.some((x) => x.code === "LINEAGE_FORK"));

    // EXPLICIT_ONLY default must refuse too
    const dExplicitOnly = selector.decide({ candidates: [root, child1, child2], registry: s.registry, config: s.config });
    assert.equal(dExplicitOnly.outcome, selector.DECISION_OUTCOMES.REFUSE);
});

test("selector: explicit capsuleId through a forked lineage stays visible in reasons and diagnostics", async () => {
    const { s, root, child1, child2 } = await buildForkedCandidates();
    const d = selector.decide({
        candidates: [root, child1, child2],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: child1.manifest.capsuleId
    });
    assert.equal(d.capsuleId, child1.manifest.capsuleId);
    assert.notEqual(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.ok(d.reasonCodes.includes("LINEAGE_FORK"), "fork must remain visible");
    assert.ok(d.diagnostics.some((x) => x.code === "LINEAGE_FORK"));
});

function forgeCapsuleWithSameEpoch(cap, newCapsuleId) {
    const { buildManifestMaterial } = require("../../src/runtime/recovery/manifest");
    const wire = JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections }));
    wire.manifest.capsuleId = newCapsuleId;
    const material = buildManifestMaterial({
        capsuleFormatVersion: wire.manifest.capsuleFormatVersion,
        capsuleId: wire.manifest.capsuleId,
        parentCapsuleId: wire.manifest.parentCapsuleId,
        epochId: wire.manifest.epochId,
        runtimeGenerationId: wire.manifest.runtimeGenerationId,
        createdAtMs: wire.manifest.createdAtMs,
        reason: wire.manifest.reason,
        status: wire.manifest.status,
        sections: wire.manifest.sections
    });
    material.manifestDigest = shaHex(material);
    return { manifest: material, sections: wire.sections };
}

test("selector: NEWEST_VALID refuses on LINEAGE_CONFLICTING_EPOCH instead of silently choosing", async () => {
    const { s: s2 } = await buildForkedCandidates();
    const capA = await new CheckpointBuilder(s2).run({ reason: "TEST", runtimeGenerationId: s2.generationLedger.current });
    const capB = await new CheckpointBuilder(s2).run({ reason: "TEST", runtimeGenerationId: s2.generationLedger.current });
    const twin = forgeCapsuleWithSameEpoch(capB, "rc-" + "c".repeat(32));
    twin.manifest.epochId = capA.manifest.epochId;
    // recompute digest over the mutated manifest
    const { buildManifestMaterial } = require("../../src/runtime/recovery/manifest");
    const m2 = buildManifestMaterial({
        capsuleFormatVersion: twin.manifest.capsuleFormatVersion,
        capsuleId: twin.manifest.capsuleId,
        parentCapsuleId: twin.manifest.parentCapsuleId,
        epochId: twin.manifest.epochId,
        runtimeGenerationId: twin.manifest.runtimeGenerationId,
        createdAtMs: twin.manifest.createdAtMs,
        reason: twin.manifest.reason,
        status: twin.manifest.status,
        sections: twin.manifest.sections
    });
    m2.manifestDigest = shaHex(m2);
    twin.manifest = m2;

    const d = selector.decide({
        candidates: [capA, twin],
        registry: s2.registry,
        config: s2.config,
        policy: "NEWEST_VALID"
    });
    assert.equal(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.deepEqual(d.reasonCodes, ["LINEAGE_CONFLICTING_EPOCH"]);
    assert.ok(d.diagnostics.some((x) => x.code === "LINEAGE_CONFLICTING_EPOCH"));
});

test("selector: explicit capsuleId under conflicting epoch keeps ambiguity visible", async () => {
    const { s } = await buildForkedCandidates();
    const capA = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const later = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const forged = forgeCapsuleWithSameEpoch(later, "rc-" + "d".repeat(32));
    forged.manifest.epochId = capA.manifest.epochId;
    const { buildManifestMaterial } = require("../../src/runtime/recovery/manifest");
    const m2 = buildManifestMaterial({
        capsuleFormatVersion: forged.manifest.capsuleFormatVersion,
        capsuleId: forged.manifest.capsuleId,
        parentCapsuleId: forged.manifest.parentCapsuleId,
        epochId: forged.manifest.epochId,
        runtimeGenerationId: forged.manifest.runtimeGenerationId,
        createdAtMs: forged.manifest.createdAtMs,
        reason: forged.manifest.reason,
        status: forged.manifest.status,
        sections: forged.manifest.sections
    });
    m2.manifestDigest = shaHex(m2);
    forged.manifest = m2;

    const d = selector.decide({
        candidates: [capA, forged],
        registry: s.registry,
        config: s.config,
        requestedCapsuleId: forged.manifest.capsuleId
    });
    assert.equal(d.capsuleId, forged.manifest.capsuleId);
    assert.notEqual(d.outcome, selector.DECISION_OUTCOMES.REFUSE);
    assert.ok(d.reasonCodes.includes("LINEAGE_CONFLICTING_EPOCH"), "conflicting epoch must remain visible");
    assert.ok(d.diagnostics.some((x) => x.code === "LINEAGE_CONFLICTING_EPOCH"));
});

function shaHex(value) {
    return require("../../src/runtime/recovery/digest").sha256Hex(
        require("../../src/runtime/recovery/canonicalJson").canonicalBytes(value)
    );
}
