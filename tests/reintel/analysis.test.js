/**
 * Tes kontrak analyzer, agregasi, model epistemik, laporan immutable,
 * hook masa depan, dan invarian keamanan.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
    analyzeArtifact, analyzerKit, hooks, model, behavior
} = require("../../src/reintel");
const {
    defineAnalyzer, makeAnalysisContext
} = analyzerKit;
const {
    freezeDeep, makeConfidence, combineConfidence,
    hypothesis, ArtifactType, AnalysisStage
} = model;
const { buildPe, corrupt } = require("./helpers/peFixture");

// ---------------------------------------------------------------------
// Kontrak analyzer (#19)
// ---------------------------------------------------------------------
test("analyzer contract: bentuk divalidasi, supports+analyze wajib", () => {
    assert.throws(() => defineAnalyzer({ version: 1, supports: () => true, analyze: () => {} }));
    assert.throws(() => defineAnalyzer({ id: "x", supports: () => true, analyze: () => {} }));
    const a = defineAnalyzer({
        id: "ok-analyzer", version: 1,
        supports: () => true, analyze: () => {}
    });
    assert.equal(a.id, "ok-analyzer");
});

function makeFactAnalyzer(id) {
    return defineAnalyzer({
        id, version: 1,
        supports: () => true,
        analyze: (ctx) => {
            const evId = ctx.addEvidence({
                source: id, kind: "content_heuristic",
                observation: `${id} mengamati sesuatu`
            });
            ctx.addObservedFact(`fakta dari ${id}`, [evId]);
        }
    });
}

// ---------------------------------------------------------------------
// Agregasi & isolasi kegagalan (#20, #21)
// ---------------------------------------------------------------------
test("agregasi multi-analyzer: bukti digabung dalam satu laporan", async () => {
    const report = await analyzeArtifact(
        { buffer: Buffer.from("teks biasa"), name: "a.txt" },
        { analyzers: [makeFactAnalyzer("alpha"), makeFactAnalyzer("beta")] }
    );
    const facts = report.findings.map((f) => f.statement);
    assert.ok(facts.includes("fakta dari alpha"));
    assert.ok(facts.includes("fakta dari beta"));
    assert.ok(report.evidence.some((e) => e.source === "alpha"));
    assert.ok(report.evidence.some((e) => e.source === "beta"));
});

test("kegagalan analyzer terisolasi: yang lain tetap jalan, laporan utuh", async () => {
    const broken = defineAnalyzer({
        id: "broken", version: 1,
        supports: () => true,
        analyze: () => { throw new Error("ledakan simulasi"); }
    });
    const report = await analyzeArtifact(
        { buffer: Buffer.from("teks biasa"), name: "a.txt" },
        { analyzers: [broken, makeFactAnalyzer("survivor")] }
    );

    const prov = report.analyzers.find((a) => a.id === "broken");
    assert.equal(prov.status, "failed");
    assert.match(prov.reason, /ledakan simulasi/);
    assert.ok(report.findings.some((f) => f.statement === "fakta dari survivor"));
    // laporan tetap sah:
    assert.ok(report.artifact.sha256);
});

// ---------------------------------------------------------------------
// Model epistemik (#22–#27)
// ---------------------------------------------------------------------
test("observed fact vs inferred claim terpisah eksplisit", async () => {
    const report = await analyzeArtifact({
        buffer: buildPe({ imports: [{ dll: "WININET.dll", functions: ["InternetOpenA"] }] }),
        name: "net.exe"
    });
    const kinds = new Set(report.findings.map((f) => f.kind));
    assert.ok(kinds.has("observed_fact"));

    const imp = report.findings.find((f) =>
        f.kind === "observed_fact" && /tabel import memuat/.test(f.statement));
    assert.ok(imp, "pembacaan tabel import adalah fakta teramati");

    // hipotesis TIDAK PERNAH berada di daftar findings (#invarian E):
    assert.ok(report.findings.every((f) => f.kind !== "hypothesis"));
    assert.ok(Array.isArray(report.hypotheses));
});

test("hipotesis wajib terikat bukti — tanpa bukti ditolak", () => {
    assert.throws(
        () => hypothesis({ statement: "dugaan tanpa bukti", supportingEvidenceIds: [] }),
        /REI_HYPOTHESIS_UNBOUND/
    );
    const h = hypothesis({
        statement: "dugaan berbukti",
        supportingEvidenceIds: ["ev-0001"]
    });
    assert.deepEqual(h.supportingEvidenceIds, ["ev-0001"]);
    assert.equal(h.status, "unverified");
});

test("confidence semantics: banding LOW/MEDIUM/HIGH deterministik", () => {
    const bands = { lowBelow: 0.35, mediumBelow: 0.7 };
    assert.equal(makeConfidence(0.2, bands).level, "LOW");
    assert.equal(makeConfidence(0.5, bands).level, "MEDIUM");
    assert.equal(makeConfidence(0.9, bands).level, "HIGH");
    assert.equal(makeConfidence(2, bands).score, 1);
    // agregasi konservatif = minimum:
    const c = combineConfidence([
        makeConfidence(0.9, bands), makeConfidence(0.4, bands)
    ], bands);
    assert.equal(c.score, 0.4);
});

test("klaim perilaku lahir dari bukti dan selalu 'possible'", async () => {
    const script = Buffer.from([
        'const cp = require("child_process");',
        'cp.exec("ls");',
        'fetch("https://example.com/x");',
        'fs.writeFile("/tmp/out", "data");',
        'console.log("HKLM\\\\Software");',
        'crypto.createCipheriv("aes-256-cbc", k, iv);'
    ].join("\n"));
    const report = await analyzeArtifact({ buffer: script, name: "tool.js" });

    const types = report.behavioralClaims.map((c) => c.type);
    for (const expected of [
        "MAY_CREATE_PROCESS", "MAY_ACCESS_NETWORK",
        "MAY_MODIFY_FILES", "MAY_PERFORM_CRYPTOGRAPHY"
    ]) {
        assert.ok(types.includes(expected), `harus ada ${expected}`);
    }
    // tidak ada klaim yang menyatakan kepastian eksekusi (#27):
    for (const c of report.behavioralClaims) {
        assert.equal(c.certainty, "possible");
        assert.ok(c.derivedFrom.length >= 1);
    }
    assert.ok(!JSON.stringify(report).includes("definitely"));
});

test("klaim perilaku dari tabel import PE", async () => {
    const report = await analyzeArtifact({
        buffer: buildPe({
            imports: [{ dll: "KERNEL32.dll", functions: ["CreateProcessW", "WriteFile"] }]
        }),
        name: "impl.exe"
    });
    const types = report.behavioralClaims.map((c) => c.type);
    assert.ok(types.includes("MAY_CREATE_PROCESS"));
    assert.ok(types.includes("MAY_MODIFY_FILES"));
});

// ---------------------------------------------------------------------
// Relasi antar-artifact (#28)
// ---------------------------------------------------------------------
test("relasi artifact: IMPORTS untuk DLL, REFERENCES untuk URL", async () => {
    const report = await analyzeArtifact({
        buffer: Buffer.from('fetch("https://contoh.id/api");\n'),
        name: "caller.js"
    });
    assert.ok(report.relationships.some((r) =>
        r.type === "REFERENCES" && r.target.startsWith("https://contoh.id")));

    const peReport = await analyzeArtifact({
        buffer: buildPe({ imports: [{ dll: "WS2_32.dll", functions: ["socket"] }] }),
        name: "r.exe"
    });
    assert.ok(peReport.relationships.some((r) =>
        r.type === "IMPORTS" && r.target === "ws2_32.dll"));
});

// ---------------------------------------------------------------------
// Laporan immutable (#29) & determinisme
// ---------------------------------------------------------------------
test("laporan immutable: deep-frozen, mutasi ditolak", async () => {
    const report = await analyzeArtifact({ buffer: Buffer.from("x"), name: "x.txt" });

    function assertFrozenDeep(obj, trail = "") {
        assert.ok(Object.isFrozen(obj), `tidak beku: ${trail}`);
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === "object") assertFrozenDeep(v, `${trail}.${k}`);
        }
    }
    assertFrozenDeep(report);

    assert.throws(() => { report.classification.type = "TEXT"; }, TypeError);
    assert.throws(() => { report.findings.push({}); }, TypeError);
});

// ---------------------------------------------------------------------
// Input korup tidak dieksekusi (#30)
// ---------------------------------------------------------------------
test("kode reintel tidak pernah me-load child_process / tidak mengeksekusi target", async () => {
    const root = path.join(__dirname, "..", "..", "src", "reintel");
    const files = [];
    (function walk(dir) {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith(".js")) files.push(p);
        }
    })(root);

    assert.ok(files.length >= 8);
    for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        assert.ok(!/require\(\s*["'].*child_process["']\s*\)/.test(src),
            `${f} memuat child_process`);
        assert.ok(!/process\.binding/.test(src), `${f} memuat process.binding`);
    }

    // input acak korup tetap menghasilkan laporan aman:
    const garbage = Buffer.from(Array.from({ length: 4096 },
        (_, i) => (i * 37 + 11) % 256));
    const report = await analyzeArtifact({ buffer: garbage, name: "garbage.bin" });
    assert.ok(report.artifact.sha256);
});

// ---------------------------------------------------------------------
// Hook masa depan (#32, #33)
// ---------------------------------------------------------------------
test("unknown-analysis hook tersedia sebagai interface + event", async () => {
    assert.equal(hooks.HOOK_EVENTS.UNKNOWN_ARTIFACT_REQUIRES_ANALYSIS,
        "reintel.unknown_artifact_requires_analysis");

    const events = [];
    await analyzeArtifact({
        buffer: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), name: "?"
    }, { emit: (type) => events.push(type) });
    assert.deepEqual(events, ["reintel.unknown_artifact_requires_analysis"]);
});

test("dynamic analysis request TIDAK mengeksekusi apa pun di V0", () => {
    const req = hooks.createDynamicAnalysisRequest({
        artifactId: "rei1-abc-1",
        dimensions: ["filesystem", "network"]
    });
    assert.equal(req.type, "DYNAMIC_ANALYSIS_REQUEST");
    assert.equal(req.executionAvailable, false);
    assert.equal(typeof req.execute, "undefined");
    assert.ok(Object.isFrozen(req));

    const cap = hooks.createProtocolCaptureInput({ kind: "usb", sourceRef: "capture.pcap" });
    assert.equal(cap.interceptionImplementedInV0, false);
    assert.throws(() => hooks.createProtocolCaptureInput({ kind: "warp" }));
});

// ---------------------------------------------------------------------
// Anggaran rekursi & embedded (#34, #35)
// ---------------------------------------------------------------------
function containerWithNested(inner, copies = 1) {
    const parts = [Buffer.from([0xde, 0xad, 0xad, 0xde])];
    for (let i = 0; i < copies; i++) {
        parts.push(Buffer.alloc(600 - (i === 0 ? 4 : 0)));
        parts.push(inner);
    }
    return Buffer.concat(parts);
}

test("rekursi embedded berbudget: kedalaman dibatasi diagnostik", async () => {
    const pe = buildPe({});
    const container = containerWithNested(pe);

    // dengan kedalaman cukup → anak dianalisis:
    const full = await analyzeArtifact({ buffer: container, name: "c.bin" });
    assert.equal(full.embeddedArtifacts.length, 1);
    assert.equal(full.embeddedAnalyses.length, 1);
    assert.equal(full.embeddedAnalyses[0].classification.type, "PE_EXECUTABLE");
    assert.ok(full.relationships.some((r) => r.type === "CONTAINS"));

    // dengan anggaran rekursi 0 → anak TIDAK dianalisis, tapi tercatat:
    const limited = await analyzeArtifact(
        { buffer: container, name: "c.bin" },
        { overrides: { limits: { maxRecursionDepth: 0 } } });
    assert.equal(limited.embeddedAnalyses.length, 0);
    assert.ok(limited.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED" && /rekursi/.test(d.message)));
});

test("budget embedded artifact ditegakkan + diagnostic", async () => {
    const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const parts = [];
    for (let i = 0; i < 12; i++) {
        parts.push(zipMagic, Buffer.alloc(520));
    }
    const buf = Buffer.concat(parts);

    const report = await analyzeArtifact(
        { buffer: buf, name: "many.bin" },
        { overrides: { limits: { maxEmbeddedArtifacts: 5 } } });

    assert.equal(report.embeddedArtifacts.length, 5);
    assert.ok(report.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED" && /embedded artifact/.test(d.message)));
});

test("budget ukuran file: buffer besar tidak deep-parse, hash tetap jalan", async () => {
    const big = Buffer.concat([
        Buffer.from([0xde, 0xad]),
        Buffer.alloc(100)
    ]);
    const report = await analyzeArtifact(
        { buffer: big, name: "big.bin" },
        { overrides: { limits: { maxDeepParseBytes: 10, maxFileBytes: 50 } } });

    assert.ok(report.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED"));
    assert.ok(report.artifact.sha256.match(/^[0-9a-f]{64}$/));
});

// ---------------------------------------------------------------------
// Provenance diagnostik (#37)
// ---------------------------------------------------------------------
test("diagnostic provenance: kode + severity + provenance analyzer", async () => {
    const badThunk = buildPe({ imports: [{ dll: "C.dll", functions: ["F"] }] });
    badThunk.writeUInt32LE(0xffffff00, findImportDescOffset(badThunk));

    const report = await analyzeArtifact({ buffer: badThunk, name: "d.exe" });
    const diag = report.diagnostics.find((d) => d.code === "PE_BAD_OFFSET");
    assert.ok(diag);
    assert.ok(diag.severity);

    for (const p of report.analyzers) {
        assert.ok(p.id && typeof p.version === "number" &&
            ["ok", "failed", "skipped"].includes(p.status));
    }
});

function findImportDescOffset(buf) {
    const peOff = buf.readUInt32LE(0x3c);
    const dirs = peOff + 4 + 20 + 112;
    const importDirRva = buf.readUInt32LE(dirs + 8);
    const secOff = dirs + 128;
    const secRva = buf.readUInt32LE(secOff + 12);
    const secPtr = buf.readUInt32LE(secOff + 20);
    return secPtr + (importDirRva - secRva);
}

// ---------------------------------------------------------------------
// Otoritas nol (#38)
// ---------------------------------------------------------------------
test("temuan bukan otoritas: authority selalu granted=false", async () => {
    const scary = await analyzeArtifact({
        buffer: buildPe({
            imports: [{ dll: "ADVAPI32.dll", functions: ["RegSetValueExW"] }]
        }),
        name: "reg.exe"
    });
    assert.ok(scary.behavioralClaims.some((c) => c.type === "MAY_ACCESS_REGISTRY"));
    assert.equal(scary.authority.granted, false);
    assert.equal(scary.futureHooks.dynamicAnalysisAvailable, false);
});

// ---------------------------------------------------------------------
// Mandiri: tanpa model LLM, tanpa Console (#39, #40)
// ---------------------------------------------------------------------
test("mandiri: tanpa model LLM dan tanpa Console", async () => {
    const root = path.join(__dirname, "..", "..", "src", "reintel");
    const files = [];
    (function walk(dir) {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith(".js")) files.push(p);
        }
    })(root);

    for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        assert.ok(!/require\(.*(\.\.\/)+.*(providers|ai\/|apps\/console|server\.js)/.test(src),
            `${f} bergantung pada runtime AI/console`);
    }

    // fungsional dengan env kosong:
    const { createReIntel } = require("../../src/reintel");
    const re = await createReIntel({ env: {} });
    const report = await re.analyzeArtifact({ buffer: Buffer.from("hello"), name: "h.txt" });
    assert.equal(report.classification.type, "TEXT");
});

// ---------------------------------------------------------------------
// Rekomendasi tahap lanjutan
// ---------------------------------------------------------------------
test("rekomendasi tahap: ARCHIVE → decomposition, anomali PE → deep analysis", async () => {
    const zip = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.alloc(64, 0x41)
    ]);
    const rep = await analyzeArtifact({ buffer: zip, name: "pack.zip" });
    assert.ok(rep.recommendedNextStages.includes(AnalysisStage.ARCHIVE_DECOMPOSITION));

    const huge = corrupt(buildPe({}), "huge-section-size");
    const rep2 = await analyzeArtifact({ buffer: huge, name: "anom.exe" });
    assert.ok(rep2.recommendedNextStages.includes(AnalysisStage.DEEP_PE_ANALYSIS));
});
