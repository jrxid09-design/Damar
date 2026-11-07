"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeFakeProvider, makeSystem } = require("./helpers/fakes");
const { CheckpointBuilder } = require("../../src/runtime/recovery/checkpoint");
const { validateCapsule } = require("../../src/runtime/recovery/validation");
const { sha256Hex } = require("../../src/runtime/recovery/digest");
const { canonicalBytes } = require("../../src/runtime/recovery/canonicalJson");

async function buildCapsule(system) {
    return new CheckpointBuilder(system).run({
        reason: "TEST",
        runtimeGenerationId: system.generationLedger.current
    });
}

function setup() {
    const s = makeSystem();
    s.registry.register(makeFakeProvider({ id: "acc", data: { seq: 1 } }));
    s.registry.register(
        makeFakeProvider({
            id: "sensorium",
            classification: "PUBLIC_STATE",
            required: false,
            schemaVersion: 2,
            data: { devices: ["lamp"] }
        })
    );
    return s;
}

function clone(cap) {
    return JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections }));
}

test("validation: pristine capsule accepted", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const v = validateCapsule(clone(cap), s.registry, s.config);
    assert.ok(v.ok);
});

test("corruption matrix: single changed byte in section payload rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.sections.acc.data.seq = 2;
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "INVALID_DIGEST");
});

test("corruption matrix: whole section replaced rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.sections.sensorium = { schemaVersion: 2, data: { devices: ["ALL_YOUR_DEVICES"] } };
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "INVALID_DIGEST");
});

test("corruption matrix: tampered manifest field rejected via manifest digest", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.manifest.reason = "FORGED";
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "INVALID_DIGEST");
});

test("corruption matrix: missing section payload rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    delete wire.sections.sensorium;
    assert.equal(validateCapsule(wire, s.registry, s.config).ok, false);
});

test("corruption matrix: duplicated section id in manifest rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.manifest.sections.push({ ...wire.manifest.sections[0] });
    // keep ordering broken too; either way must fail closed
    assert.equal(validateCapsule(wire, s.registry, s.config).ok, false);
});

test("corruption matrix: extraneous undeclared payload section rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.sections.ghost = { schemaVersion: 1, data: { x: 1 } };
    assert.equal(validateCapsule(wire, s.registry, s.config).ok, false);
});

test("corruption matrix: unknown provider referenced by capsule fails closed", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    // ghostsys sorts between acc and sensorium -> keep canonical ordering
    wire.manifest.sections.splice(1, 0, {
        sectionId: "ghostsys",
        schemaVersion: 1,
        classification: "INTERNAL_STATE",
        required: true,
        byteLength: 0,
        digest: "0".repeat(64)
    });
    wire.sections.ghostsys = { schemaVersion: 1, data: {} };
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "UNKNOWN_PROVIDER");
});

test("corruption matrix: unsupported provider schema version -> incompatible", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    // attacker rewrites both copies of schemaVersion AND recomputes digests
    wire.sections.sensorium.schemaVersion = 99;
    const entry = wire.manifest.sections.find((x) => x.sectionId === "sensorium");
    entry.schemaVersion = 99;
    const bytes = canonicalBytes(wire.sections.sensorium);
    entry.byteLength = bytes.byteLength;
    entry.digest = sha256Hex(bytes);
    const mbytes = canonicalBytes(require("../../src/runtime/recovery/manifest").buildManifestMaterial({
        ...wire.manifest,
        sections: wire.manifest.sections
    }));
    wire.manifest.manifestDigest = sha256Hex(mbytes);
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.incompatible, true);
    assert.equal(v.diagnostics[0].code, "UNSUPPORTED_VERSION");
});

test("corruption matrix: semantically invalid payload with RECOMPUTED valid digest still rejected", async () => {
    const s = setup();
    const vault = makeFakeProvider({ id: "vault", data: { whatever: true } });
    s.registry.register(vault);
    const cap = await buildCapsule(s);
    // attacker flips semantics AFTER a legitimately signed-off checkpoint
    vault.__state.validateRejects = "payload violates vault semantics";
    const wire = clone(cap);
    wire.sections.vault = { schemaVersion: 1, data: { forgedRootGrant: true } };
    const entry = wire.manifest.sections.find((x) => x.sectionId === "vault");
    const bytes = canonicalBytes(wire.sections.vault);
    entry.byteLength = bytes.byteLength;
    entry.digest = sha256Hex(bytes);
    const mbytes = canonicalBytes(require("../../src/runtime/recovery/manifest").buildManifestMaterial({
        ...wire.manifest,
        sections: wire.manifest.sections
    }));
    wire.manifest.manifestDigest = sha256Hex(mbytes);

    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false, "recomputed SHA-256 must not buy semantic trust");
    assert.equal(v.diagnostics[0].code, "PROVIDER_REJECTED");
});

test("corruption matrix: oversized payload with recomputed digest rejected by bounds", async () => {
    const s = makeSystem({ maxSectionBytes: 64 });
    s.registry.register(makeFakeProvider({ id: "big" }));
    const cap = await new CheckpointBuilder(s).run({
        reason: "TEST",
        runtimeGenerationId: s.generationLedger.current
    });
    const wire = clone(cap);
    wire.sections.big = { schemaVersion: 1, data: { blob: "y".repeat(4096) } };
    const entry = wire.manifest.sections.find((x) => x.sectionId === "big");
    const bytes = canonicalBytes(wire.sections.big);
    entry.byteLength = bytes.byteLength;
    entry.digest = sha256Hex(bytes);
    const mbytes = canonicalBytes(require("../../src/runtime/recovery/manifest").buildManifestMaterial({
        ...wire.manifest,
        sections: wire.manifest.sections
    }));
    wire.manifest.manifestDigest = sha256Hex(mbytes);
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "SECTION_TOO_LARGE");
});

test("corruption matrix: prototype-polluting payload keys rejected even with recomputed digest", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = JSON.parse(JSON.stringify({ manifest: cap.manifest, sections: cap.sections }));
    const hostile = JSON.parse('{"__proto__":{"isAdmin":true},"seq":9}');
    wire.sections.acc = hostile;
    const entry = wire.manifest.sections.find((x) => x.sectionId === "acc");
    let bytes = null;
    try {
        bytes = canonicalBytes(hostile);
    } catch {
        // canonicalizer may reject outright — that is a pass
    }
    if (bytes) {
        entry.byteLength = bytes.byteLength;
        entry.digest = sha256Hex(bytes);
        const mbytes = canonicalBytes(require("../../src/runtime/recovery/manifest").buildManifestMaterial({
            ...wire.manifest,
            sections: wire.manifest.sections
        }));
        wire.manifest.manifestDigest = sha256Hex(mbytes);
        assert.equal(validateCapsule(wire, s.registry, s.config).ok, false);
    }
});

test("corruption matrix: malformed ids in manifest rejected", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.manifest.capsuleId = "../../etc/passwd";
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "MALFORMED_ID");
});

test("corruption matrix: non-COMPLETE status rejected as incomplete", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.manifest.status = "BUILDING";
    const v = validateCapsule(wire, s.registry, s.config);
    assert.equal(v.ok, false);
    assert.equal(v.diagnostics[0].code, "INCOMPLETE_CAPSULE");
});

test("corruption matrix: unknown top-level fields rejected (fail closed)", async () => {
    const s = setup();
    const cap = await buildCapsule(s);
    const wire = clone(cap);
    wire.surprise = "extra";
    assert.equal(validateCapsule(wire, s.registry, s.config).ok, false);
});

test("validation: non-object input rejected safely", () => {
    for (const bad of [null, undefined, 42, "capsule", [], () => {}]) {
        const v = validateCapsule(bad, setup().registry, makeSystem().config);
        assert.equal(v.ok, false);
    }
});
