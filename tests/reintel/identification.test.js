/**
 * Tes mesin identifikasi: magic bytes menang atas extension,
 * klasifikasi teks/skrip, dan UNKNOWN sebagai hasil sah.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { analyzeArtifact, model } = require("../../src/reintel");
const { ArtifactType } = model;
const { buildPe } = require("./helpers/peFixture");

test("extension tidak otoritatif: foo.txt berisi PE → terklasifikasi PE", async () => {
    const pe = buildPe({});
    const report = await analyzeArtifact({ buffer: pe, name: "foo.txt" });

    assert.equal(report.classification.type, ArtifactType.PE_EXECUTABLE);
    // kontradiksi dicatat sebagai bukti:
    const extEv = report.evidence.find((e) =>
        e.kind === "extension" && /TIDAK SESUAI/.test(e.observation));
    assert.ok(extEv, "ketidaksesuaian extension vs struktur harus tampak di evidence");
});

test("magic bytes: ELF dikenali dari header, bukan nama", async () => {
    const elf = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
        Buffer.alloc(56),
        Buffer.alloc(64, 0xab)
    ]);
    const report = await analyzeArtifact({ buffer: elf, name: "tanpa-ekstensi" });
    assert.equal(report.classification.type, ArtifactType.ELF);
    assert.ok(report.classification.confidence.score >= 0.9);
});

test("teks polos → TEXT dengan confidence wajar", async () => {
    const text = Buffer.from("catatan biasa\nbaris kedua\n");
    const report = await analyzeArtifact({ buffer: text, name: "notes.txt" });
    assert.equal(report.classification.type, ArtifactType.TEXT);
    const kind = report.classification.confidence.level;
    assert.ok(["MEDIUM", "HIGH"].includes(kind));
});

test("shebang tanpa extension → SCRIPT", async () => {
    const script = Buffer.from("#!/usr/bin/env python3\nimport os\nprint(os.getpid())\n");
    const report = await analyzeArtifact({ buffer: script, name: "noext" });
    assert.equal(report.classification.type, ArtifactType.SCRIPT);
});

test("extension .py + konten teks → SCRIPT", async () => {
    const script = Buffer.from("import requests\nprint('hi')\n");
    const report = await analyzeArtifact({ buffer: script, name: "tool.py" });
    assert.equal(report.classification.type, ArtifactType.SCRIPT);
});

test("UNKNOWN tetap first-class: tidak ada paksaan klasifikasi", async () => {
    const weird = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    const report = await analyzeArtifact({ buffer: weird, name: "mystery.dat" });
    assert.equal(report.classification.type, ArtifactType.UNKNOWN);
    // UNKNOWN memicu event hook masa depan bila emit disediakan:
    const events = [];
    await analyzeArtifact({ buffer: weird, name: "mystery.dat" }, {
        emit: (type, payload) => events.push({ type, payload })
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "reintel.unknown_artifact_requires_analysis");
    assert.ok(events[0].payload.artifactId);
});
