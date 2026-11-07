/**
 * Tes identitas artifact: SHA-256, ArtifactId stabil, determinisme.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { hashing } = require("../../src/reintel");
const { analyzeArtifact } = require("../../src/reintel");

test("SHA-256 identity: hash buffer dan streaming path identik", async () => {
    const payload = Buffer.from("damar re intelligence fixture\n".repeat(1000));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reintel-id-"));
    const p = path.join(dir, "blob.bin");
    fs.writeFileSync(p, payload);

    const fromBuffer = hashing.sha256Buffer(payload);
    const fromFile = await hashing.sha256File(p);

    assert.equal(fromFile, fromBuffer);
    assert.match(fromFile, /^[0-9a-f]{64}$/);
    // vektor dikenal:
    assert.equal(
        hashing.sha256Buffer(Buffer.from("abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
});

test("ArtifactId stabil: isi sama → id sama meski nama beda", async () => {
    const a = Buffer.from("stable-content-v1");
    const ra = await analyzeArtifact({ buffer: a, name: "a.bin" });
    const ra2 = await analyzeArtifact({ buffer: Buffer.from(a), name: "nama-lain.bin" });
    assert.equal(ra.artifact.artifactId, ra2.artifact.artifactId);
    assert.equal(ra.artifact.artifactId, `rei1-${ra.artifact.sha256}-${a.length}`);
});

test("ArtifactId: isi beda → id berbeda", async () => {
    const ra = await analyzeArtifact({ buffer: Buffer.from("isi satu"), name: "x" });
    const rb = await analyzeArtifact({ buffer: Buffer.from("isi dua"), name: "x" });
    assert.notEqual(ra.artifact.artifactId, rb.artifact.artifactId);
});

test("Deterministik: analisis berulang menghasilkan laporan identik", async () => {
    const { buildPe } = require("./helpers/peFixture");
    const pe = buildPe({
        isDll: true,
        imports: [{ dll: "USER32.dll", functions: ["MessageBoxW"] }],
        exports: { moduleName: "rep.dll", functions: ["F1"] }
    });

    const r1 = await analyzeArtifact({ buffer: pe, name: "rep.dll" }, { nowEpochMs: 0 });
    const r2 = await analyzeArtifact({ buffer: pe, name: "rep.dll" }, { nowEpochMs: 0 });

    assert.deepStrictEqual(r1, r2);
    assert.equal(r1.generatedAtEpochMs, 0); // clock disuntik, bukan waktu-dinding
});
