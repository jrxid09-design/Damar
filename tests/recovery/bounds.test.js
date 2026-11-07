"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder, RecoveryCheckpointAborted } = require("../../src/runtime/recovery/checkpoint");
const { resolveRecoveryConfig, DEFAULT_RECOVERY_CONFIG } = require("../../src/runtime/recovery/config");
const { DiagnosticCollector } = require("../../src/runtime/recovery/diagnostics");

test("config: defaults frozen and complete", () => {
    assert.ok(Object.isFrozen(DEFAULT_RECOVERY_CONFIG));
    for (const key of [
        "maxCapsuleBytes", "maxSectionBytes", "maxSections", "maxCandidateCapsules",
        "maxDiagnostics", "maxLineageDepth", "maxProviderCount"
    ]) {
        assert.ok(Number.isSafeInteger(DEFAULT_RECOVERY_CONFIG[key]) && DEFAULT_RECOVERY_CONFIG[key] > 0);
    }
});

test("config: no advertised-but-unenforced bounds exist", () => {
    // maxCapsuleBytes is enforced in builder + validator; every other bound
    // has a live enforcement site. There is deliberately no metadata surface
    // in V0, so no metadata bounds are advertised.
    assert.equal("maxMetadataKeys" in DEFAULT_RECOVERY_CONFIG, false);
    assert.equal("maxMetadataStringLength" in DEFAULT_RECOVERY_CONFIG, false);
});

test("config: unknown override keys rejected", () => {
    assert.throws(() => resolveRecoveryConfig({ maxSectionsHack: 1e9 }), /unknown recovery config key/);
});

test("config: non-positive and non-integer bounds rejected", () => {
    assert.throws(() => resolveRecoveryConfig({ maxSections: 0 }), RangeError);
    assert.throws(() => resolveRecoveryConfig({ maxSectionBytes: -5 }), RangeError);
    assert.throws(() => resolveRecoveryConfig({ maxProviderCount: 2.5 }), RangeError);
});

test("bounds: section count enforced at checkpoint time", async () => {
    const s = makeSystem({ maxSections: 1 });
    s.registry.register(makeFakeProvider({ id: "a" }));
    s.registry.register(makeFakeProvider({ id: "b" }));
    await assert.rejects(
        () => new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current }),
        RecoveryCheckpointAborted
    );
    assert.equal(s.store.size, 0);
});

test("bounds: provider count enforced at registration", () => {
    const s = makeSystem({ maxProviderCount: 1 });
    s.registry.register(makeFakeProvider({ id: "a" }));
    assert.throws(() => s.registry.register(makeFakeProvider({ id: "b" })), /provider count exceeds/);
    assert.throws(() => s.registry.register(makeFakeProvider({ id: "a" })), /already registered/);
});

test("bounds: diagnostics collector truncates at bound", () => {
    const c = new DiagnosticCollector(3);
    for (let i = 0; i < 10; i += 1) {
        c.add("UNKNOWN", { message: `d${i}` });
    }
    assert.equal(c.snapshot().length, 3);
});

test("bounds: oversized hostile capsule rejected before excessive allocation where feasible", async () => {
    const s = makeSystem({ maxSectionBytes: 16 });
    s.registry.register(makeFakeProvider({ id: "acc", data: { blob: "z".repeat(4096) } }));
    await assert.rejects(
        () => new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current }),
        (err) =>
            err instanceof RecoveryCheckpointAborted &&
            /exceeds size bound/.test(String(err.cause?.message ?? ""))
    );
});

test("bounds: maxCapsuleBytes enforced during checkpoint build before commit", async () => {
    const s = makeSystem({ maxSectionBytes: 1024, maxCapsuleBytes: 512 });
    s.registry.register(makeFakeProvider({ id: "acc", data: { blob: "x".repeat(600) } }));
    try {
        await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
        assert.fail("expected checkpoint abort");
    } catch (err) {
        assert.ok(err instanceof RecoveryCheckpointAborted);
        assert.ok(
            err.diagnostics.some((d) => d.code === "CAPSULE_TOO_LARGE"),
            JSON.stringify(err.diagnostics)
        );
    }
    assert.equal(s.store.size, 0, "oversized capsule must never be committed");
});

test("bounds: maxCapsuleBytes enforced by validateCapsule on untrusted candidates", async () => {
    const { validateCapsule } = require("../../src/runtime/recovery/validation");
    const { canonicalBytes } = require("../../src/runtime/recovery/canonicalJson");
    const { sha256Hex } = require("../../src/runtime/recovery/digest");
    const { buildManifestMaterial } = require("../../src/runtime/recovery/manifest");

    const s = makeSystem({ maxSectionBytes: 64 * 1024, maxCapsuleBytes: 2048 });
    s.registry.register(makeFakeProvider({ id: "acc", data: { seq: 1 } }));
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const wire = JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections }));

    // hostile inflation: section bound passes, whole-capsule bound must catch it
    wire.sections.acc = { schemaVersion: 1, data: { blob: "z".repeat(3000) } };
    const entry = wire.manifest.sections.find((x) => x.sectionId === "acc");
    const bytes = canonicalBytes(wire.sections.acc);
    entry.byteLength = bytes.byteLength;
    entry.digest = sha256Hex(bytes);
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
    material.manifestDigest = sha256Hex(canonicalBytes(material));
    wire.manifest = material;

    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "CAPSULE_TOO_LARGE");
});

test("bounds: legitimate capsule under the limit still passes validation", async () => {
    const { validateCapsule } = require("../../src/runtime/recovery/validation");
    const s = makeSystem({ maxCapsuleBytes: 64 * 1024 });
    s.registry.register(makeFakeProvider({ id: "acc", data: { seq: 1 } }));
    const cap = await new CheckpointBuilder(s).run({ reason: "TEST", runtimeGenerationId: s.generationLedger.current });
    const v = validateCapsule(
        JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections })),
        s.registry,
        s.config
    );
    assert.equal(v.ok, true);
});
