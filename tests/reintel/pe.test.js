/**
 * Tes parser PE statis: valid, korup, terpotong, offset mustahil —
 * semuanya harus gagal secara DIAGNOSTIK, tidak pernah crash atau
 * membaca di luar batas.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { analyzeArtifact, pe } = require("../../src/reintel");
const { buildPe, corrupt } = require("./helpers/peFixture");

const LIMITS = {
    maxSections: 96, maxImports: 2048, maxImportDlls: 128,
    maxExports: 4096, maxStringScanBytes: 8 * 1024 * 1024,
    maxStrings: 5000, minStringLength: 4
};

test("PE minimal valid dikenali sebagai executable", async () => {
    const pe = buildPe({});
    const report = await analyzeArtifact({ buffer: pe, name: "min.exe" });
    assert.equal(report.classification.type, "PE_EXECUTABLE");
});

test("PE dengan bit DLL → PE_DLL", async () => {
    const report = await analyzeArtifact(
        { buffer: buildPe({ isDll: true }), name: "lib.dll" });
    assert.equal(report.classification.type, "PE_DLL");
});

test("arsitektur terekstrak: x64 dan x86 (PE32)", async () => {
    const x64 = pe.parsePe(buildPe({ machine: 0x8664 }), LIMITS);
    const x86 = pe.parsePe(buildPe({ machine: 0x14c, pe32Plus: false }), LIMITS);
    assert.equal(x64.architecture, "x64");
    assert.ok(x64.pe32Plus);
    assert.equal(x86.architecture, "x86");
    assert.equal(x86.pe32Plus, false);
});

test("section terekstrak: nama + karakteristik", async () => {
    const parsed = pe.parsePe(buildPe({}), LIMITS);
    assert.equal(parsed.sections.length, 1);
    assert.equal(parsed.sections[0].name, ".idata");
    assert.ok(parsed.sections[0].flags.includes("READ"));
    assert.ok(parsed.sections[0].flags.includes("INITIALIZED_DATA"));
});

test("import terekstrak: DLL dan fungsinya", async () => {
    const parsed = pe.parsePe(buildPe({
        imports: [{ dll: "ADVAPI32.dll", functions: ["RegSetValueExW", "RegOpenKeyExW"] }]
    }), LIMITS);
    assert.deepEqual(parsed.imports, [{
        dll: "ADVAPI32.dll",
        functions: ["RegSetValueExW", "RegOpenKeyExW"]
    }]);
});

test("export terekstrak", async () => {
    const parsed = pe.parsePe(buildPe({
        exports: { moduleName: "fx.dll", functions: ["Alpha", "Beta"] }
    }), LIMITS);
    assert.equal(parsed.exports.dllName, "fx.dll");
    assert.deepEqual(parsed.exports.functions, ["Alpha", "Beta"]);
});

test("timestamp hanya metadata: ada di laporan, tak dipercaya sebagai kronologi", async () => {
    const parsed = pe.parsePe(buildPe({ timestamp: 0x12345678 }), LIMITS);
    assert.equal(parsed.timestampField, 0x12345678);
    // evidence eksplisit menyatakan metadata:
    const report = await analyzeArtifact({ buffer: buildPe({}), name: "t.exe" });
    const tsEv = report.evidence.find((e) => /dapat dipalsukan/.test(e.observation));
    assert.ok(tsEv, "evidence timestamp wajib menandai bahwa field bisa dipalsukan");
});

test("PE terpotong → gagal diagnostik, tanpa crash", async () => {
    const truncated = corrupt(buildPe({
        imports: [{ dll: "A.dll", functions: ["Fn"] }]
    }), "truncate-half");

    const report = await analyzeArtifact({ buffer: truncated, name: "cut.exe" });
    assert.ok(report.diagnostics.length >= 1);
    assert.ok(report.analyzers.some((a) => a.id === "pe-static"));
    // laporan tetap utuh dan sah meski parsial:
    assert.ok(report.artifact.sha256);
});

test("e_lfanew absurd → ditolak diagnostik, tetap UNKNOWN-safe", async () => {
    const bad = corrupt(buildPe({}), "bad-e-lfanew");
    const parsed = pe.parsePe(bad, LIMITS);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.diagnostics.length >= 1);

    // klasifikasi turun ke BINARY/UNKNOWN — MZ saja bukan cukup bukti PE.
    const report = await analyzeArtifact({ buffer: bad, name: "bad.exe" });
    assert.notEqual(report.classification.type, "PE_EXECUTABLE");
});

test("RVA thunk mustahil → diagnostic PE_BAD_OFFSET, hasil parsial", async () => {
    const badThunk = corrupt(buildPe({
        imports: [{ dll: "B.dll", functions: ["FnOne"] }]
    }), "absurd-thunk-rva");

    const parsed = pe.parsePe(badThunk, LIMITS);
    assert.equal(parsed.ok, true); // struktur utama tetap terbaca
    assert.ok(parsed.diagnostics.some((d) => d.code === "PE_BAD_OFFSET"));
});

test("section size mustahil → anomali terdeteksi sebagai temuan, bukan crash", async () => {
    const huge = corrupt(buildPe({}), "huge-section-size");
    const parsed = pe.parsePe(huge, LIMITS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sections[0].beyondEof, true);

    const report = await analyzeArtifact({ buffer: huge, name: "huge.exe" });
    const claim = report.findings.find((f) =>
        /tidak konsisten dengan ukuran file/.test(f.statement));
    assert.ok(claim, "anomali section harus muncul sebagai inferred claim");
});
