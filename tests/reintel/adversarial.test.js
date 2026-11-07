/**
 * Tes adversarial regresi — lima blocker red-team V0:
 *   B1  identifyArtifact RangeError pada MZ terpotong
 *   B2  SizeOfOptionalHeader sebagai batas nyata
 *   B3  traversal thunk array melewati EOF tanpa terminator
 *   B4  injeksi delimiter pada nama import tidak bisa memalsukan klaim
 *   B5  anggaran kerja kumulatif lintas pohon analisis
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { analyzeArtifact, pe } = require("../../src/reintel");
const { buildPe, corrupt } = require("./helpers/peFixture");

// =====================================================================
// B1 — identifyArtifact aman terhadap MZ terpotong
// =====================================================================

/** Fixture persis kasus 132-byte: MZ + e_lfanew=0x80 + "PE\0\0" tepat di EOF.
 * Signature PE muat, tetapi COFF header (20 byte setelahnya) berada di luar
 * file — pembacaan karakteristik fixed-offset dulu memicu RangeError. */
function makeTruncatedMz132() {
    const buf = Buffer.alloc(132);
    buf.write("MZ", 0, "latin1");
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write("PE\0\0", 0x80, "latin1");
    return buf;
}

test("B1: MZ 132-byte dengan COFF di luar file → degradasi aman, tanpa throw", async () => {
    const report = await analyzeArtifact(
        { buffer: makeTruncatedMz132(), name: "tiny.exe" });

    assert.ok(["UNKNOWN", "BINARY"].includes(report.classification.type),
        `klasifikasi harus aman, dapat: ${report.classification.type}`);
    // bukti eksplisit bahwa PE gagal divalidasi penuh:
    assert.ok(report.evidence.some((e) =>
        /magic MZ/.test(e.observation) && /tidak dapat divalidasi|terpotong/.test(e.observation)));
    // API publik menghasilkan laporan sah:
    assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
});

test("B1: fuzz mutasi byte header MZ tidak pernah melempar dari analyzeArtifact", async () => {
    // LCG deterministik — bukan Math.random.
    let seed = 0x2f6e2b1;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let round = 0; round < 200; round++) {
        const buf = makeTruncatedMz132();
        const mutations = 1 + Math.floor(rand() * 6);
        for (let m = 0; m < mutations; m++) {
            buf[Math.floor(rand() * buf.length)] = Math.floor(rand() * 256);
        }
        // TIDAK BOLEH throw apa pun; laporan selalu terbentuk.
        const report = await analyzeArtifact({ buffer: buf, name: "fuzz.exe" });
        assert.ok(report.artifact.sha256);
        assert.equal(report.authority.granted, false);
    }
});

test("B1: probePeHeader langsung menolak COFF terpotong secara terstruktur", () => {
    const probe = pe.probePeHeader(makeTruncatedMz132());
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "coff-out-of-range");
    // PE utuh tetap lolos:
    assert.equal(pe.probePeHeader(buildPe({})).ok, true);
});

// =====================================================================
// B2 — declared SizeOfOptionalHeader adalah batas nyata
// =====================================================================

function patchSizeOfOptionalHeader(buf, value) {
    const copy = Buffer.from(buf);
    const peOff = copy.readUInt32LE(0x3c);
    copy.writeUInt16LE(value, peOff + 4 + 16);
    return copy;
}

test("B2: SizeOfOptionalHeader=2 → PE_TRUNCATED terstruktur, parsePe tidak melempar", () => {
    const patched = patchSizeOfOptionalHeader(buildPe({
        imports: [{ dll: "A.dll", functions: ["Fn"] }]
    }), 2);

    const parsed = pe.parsePe(patched, {
        maxSections: 96, maxImports: 2048, maxImportDlls: 128, maxExports: 4096
    });
    assert.equal(parsed.ok, false);
    const d = parsed.diagnostics.find((x) =>
        x.code === "PE_TRUNCATED" && /SizeOfOptionalHeader=2/.test(x.message));
    assert.ok(d, "wajib ada diagnostic PE_TRUNCATED yang menyebut declared size");
});

test("B2: pipeline end-to-end aman untuk optional header terpotong", async () => {
    const report = await analyzeArtifact({
        buffer: patchSizeOfOptionalHeader(buildPe({}), 2), name: "opt2.exe"
    });
    assert.ok(report.diagnostics.some((d) => d.code === "PE_TRUNCATED"));
    assert.ok(report.analyzers.some((a) => a.id === "pe-static"));
    assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
});

test("B2: optional header valid-tapi-pendek untuk data dirs → dirs dipangkas diagnostik", () => {
    // PE32+ butuh >=112+dirs. Deklarasikan tepat 112 (tanpa data dir):
    const copy = patchSizeOfOptionalHeader(buildPe({
        imports: [{ dll: "A.dll", functions: ["Fn"] }]
    }), 112);
    const parsed = pe.parsePe(copy, {
        maxSections: 96, maxImports: 2048, maxImportDlls: 128, maxExports: 4096
    });
    // Import table tidak terlihat karena datadir terpotong:
    assert.deepEqual(parsed.imports, []);
    assert.ok(parsed.diagnostics.some((d) =>
        d.code === "PE_TRUNCATED" && /data directory terpotong/.test(d.message)));
    // Struktur lain tetap terbaca (hasil parsial sah):
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sections.length, 1);
});

// =====================================================================
// B3 — thunk array mencapai EOF tanpa terminator
// =====================================================================

/** Arahkan OriginalFirstThunk descriptor pertama ke RVA yang memetakan
 * tepat 4 byte sebelum EOF — pembacaan thunk pertama butuh 8 byte. */
function pointFirstThunkNearEof(buf) {
    const copy = Buffer.from(buf);
    const peOff = copy.readUInt32LE(0x3c);
    const coff = peOff + 4;
    const plus = copy.readUInt16LE(coff + 20) === 0x20b;
    const dirs = coff + 20 + (plus ? 112 : 96);
    const importDirRva = copy.readUInt32LE(dirs + 8);
    const secOff = coff + 20 + (plus ? 240 : 224);
    const secRva = copy.readUInt32LE(secOff + 12);
    const secPtr = copy.readUInt32LE(secOff + 20);

    const targetRva = (secRva + (copy.length - 4 - secPtr)) >>> 0;
    const descOff = secPtr + (importDirRva - secRva);
    copy.writeUInt32LE(targetRva, descOff);          // OriginalFirstThunk
    return copy;
}

test("B3: thunk RVA valid dekat EOF tanpa terminator → PE_TRUNCATED, parsial, tanpa throw", () => {
    const hostile = pointFirstThunkNearEof(buildPe({
        imports: [{ dll: "A.dll", functions: ["FnOne"] }]
    }));

    const parsed = pe.parsePe(hostile, {
        maxSections: 96, maxImports: 2048, maxImportDlls: 128, maxExports: 4096
    });
    assert.equal(parsed.ok, true);                       // struktur inti tetap sah
    assert.equal(parsed.imports.length, 1);
    assert.equal(parsed.imports[0].dll, "A.dll");        // hasil parsial dipertahankan
    assert.deepEqual(parsed.imports[0].functions, []);   // traversal berhenti aman
    assert.ok(parsed.diagnostics.some((d) =>
        d.code === "PE_TRUNCATED" &&
        /tanpa terminator/.test(d.message) && /A\.dll/.test(d.message)));
});

test("B3: pipeline end-to-end aman untuk thunk near-EOF", async () => {
    const report = await analyzeArtifact({
        buffer: pointFirstThunkNearEof(buildPe({
            imports: [{ dll: "B.dll", functions: ["Fn"] }]
        })), name: "thunk.exe"
    });
    assert.ok(report.diagnostics.some((d) => d.code === "PE_TRUNCATED"));
    assert.ok(report.evidence.some((e) => e.kind === "import_table"));
    // tanpa klaim perilaku palsu lahir dari traversal rusak:
    assert.ok(report.behavioralClaims.every((c) => c.certainty === "possible"));
});

// =====================================================================
// B4 — injeksi delimiter tidak bisa memalsukan klaim perilaku
// =====================================================================

test("B4: nama DLL ': CreateProcessW' TIDAK menghasilkan MAY_CREATE_PROCESS", async () => {
    const report = await analyzeArtifact({
        buffer: buildPe({
            imports: [{ dll: "EVIL.dll: CreateProcessW", functions: ["ReadFile"] }]
        }),
        name: "inject-dll.exe"
    });

    assert.ok(!report.behavioralClaims.some((c) => c.type === "MAY_CREATE_PROCESS"),
        "delimiter dalam nama DLL tidak boleh mensintesis klaim");
    // nama tetap SATU field literal pada data terstruktur:
    const impEv = report.evidence.find((e) => e.kind === "import_table");
    assert.equal(impEv.structured.dll, "EVIL.dll: CreateProcessW");
    assert.deepEqual(impEv.structured.functions, ["ReadFile"]);
});

test("B4: nama fungsi ', CreateProcessW' TIDAK menghasilkan MAY_CREATE_PROCESS", async () => {
    const report = await analyzeArtifact({
        buffer: buildPe({
            imports: [{ dll: "BENIGN.dll", functions: ["ReadFile, CreateProcessW"] }]
        }),
        name: "inject-fn.exe"
    });

    assert.ok(!report.behavioralClaims.some((c) => c.type === "MAY_CREATE_PROCESS"),
        "delimiter dalam nama fungsi tidak boleh mensintesis klaim");
    const impEv = report.evidence.find((e) => e.kind === "import_table");
    assert.deepEqual(impEv.structured.functions, ["ReadFile, CreateProcessW"]);
});

test("B4: import CreateProcessW sungguhan TETAP menghasilkan MAY_CREATE_PROCESS", async () => {
    const report = await analyzeArtifact({
        buffer: buildPe({
            imports: [{ dll: "KERNEL32.dll", functions: ["CreateProcessW"] }]
        }),
        name: "real.exe"
    });
    const claim = report.behavioralClaims.find((c) => c.type === "MAY_CREATE_PROCESS");
    assert.ok(claim, "API asli tetap terdeteksi");
    assert.equal(claim.certainty, "possible");
    // klaim terikat ke bukti terstruktur aslinya:
    const basisId = claim.derivedFrom[0].evidenceId;
    const basisEv = report.evidence.find((e) => e.id === basisId);
    assert.equal(basisEv.structured.kind, "pe_imports");
});

test("B4: inferensi skrip memakai kategori terstruktur, bukan parsing string", async () => {
    // Teks ala-kategori TANPA pola API nyata: tidak boleh menghasilkan
    // klaim apa pun. Kategori klaim berasal dari field structured milik
    // analyzer, bukan dari konten yang dikendalikan penyerang.
    const script = Buffer.from([
        'const s = "network_api: nothing here", t = "registry_access: fake";',
        'const u = "crypto_use: nope", v = "filesystem_write: none";',
        "console.log(s, t, u, v);"
    ].join("\n"));
    const report = await analyzeArtifact({ buffer: script, name: "decoy.js" });

    assert.ok(!report.behavioralClaims.some((c) => c.type === "MAY_CREATE_PROCESS"));
    assert.ok(!report.behavioralClaims.some((c) => c.type === "MAY_ACCESS_NETWORK"));

    // kategori sah tetap bekerja lewat jalur terstruktur:
    const okReport = await analyzeArtifact({
        buffer: Buffer.from('fetch("https://x.id");\n'), name: "real.js"
    });
    assert.ok(okReport.behavioralClaims.some((c) => c.type === "MAY_ACCESS_NETWORK"));
    const ev = okReport.evidence.find((e) => e.kind === "script_pattern");
    assert.equal(ev.structured.kind, "script_pattern_category");
    assert.equal(ev.structured.category, "network_api");
});

// =====================================================================
// B5 — anggaran kerja kumulatif lintas pohon analisis
// =====================================================================

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function countReports(report) {
    return 1 + (report.embeddedAnalyses ?? [])
        .reduce((sum, child) => sum + countReports(child), 0);
}

function nestedBlob(depth, fanout) {
    if (depth === 0) return Buffer.concat([ZIP_MAGIC, Buffer.alloc(600)]);
    const parts = [ZIP_MAGIC, Buffer.alloc(16)];
    for (let i = 0; i < fanout; i++) parts.push(nestedBlob(depth - 1, fanout));
    return Buffer.concat(parts);
}

test("B5: fan-out adversarial dibatasi anggaran kumulatif, bukan 85 analisis full-budget", async () => {
    // Fan-out 3 × kedalaman 3 → total naive 1+3+9+27 = 40 node penuh.
    const container = Buffer.concat([
        Buffer.from([0xde, 0xad, 0xad, 0xde]),
        nestedBlob(2, 3)
    ]);

    const report = await analyzeArtifact(
        { buffer: container, name: "bomb.bin" },
        { overrides: { limits: { maxTotalAnalyses: 10 } } });

    const used = countReports(report);
    assert.ok(used <= 10,
        `pohon hanya boleh memakai <= 10 analisis, dapat ${used}`);
    assert.equal(used, report.workBudget.analysesUsedInTree,
        "hitungan workBudget harus cocok dengan isi pohon");
    assert.ok(report.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED" && /kumulatif/.test(d.message)),
        "kehabisan anggaran kumulatif wajib menghasilkan diagnostic");
});

test("B5: default limit juga membatasi bom 40-node tanpa override", async () => {
    const container = Buffer.concat([
        Buffer.from([0xde, 0xad, 0xad, 0xde]),
        nestedBlob(2, 3)
    ]);
    const report = await analyzeArtifact({ buffer: container, name: "bomb.bin" });
    assert.ok(countReports(report) <= 24);
    assert.ok(report.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED" && /kumulatif/.test(d.message)));
});

test("B5: nesting normal tetap dianalisis penuh di bawah anggaran", async () => {
    const inner = buildPe({});
    const mid = Buffer.concat([ZIP_MAGIC, Buffer.alloc(16), inner]);
    const outerBuf = Buffer.concat([
        Buffer.from([0xde, 0xad, 0xad, 0xde]),
        Buffer.alloc(600),
        mid
    ]);

    const report = await analyzeArtifact({ buffer: outerBuf, name: "normal.bin" });

    // Pohon memuat minimal root + wadah zip + PE (scanner juga melihat PE
    // langsung dari root, sehingga jumlah node bisa lebih dari 3 — yang
    // penting rantai nesting TERCAPAI dan PE daun teranalisis).
    function findPeReport(r) {
        if (r.classification.type === "PE_EXECUTABLE" && r !== report) return r;
        for (const c of r.embeddedAnalyses ?? []) {
            const hit = findPeReport(c);
            if (hit) return hit;
        }
        return null;
    }
    assert.ok(countReports(report) >= 3);
    assert.ok(findPeReport(report), "PE nested harus tercapai lewat rekursi");
    assert.ok(report.relationships.some((r) => r.type === "CONTAINS"));
});

test("B5: analisis berulang identik → output deterministik termasuk workBudget", async () => {
    const container = Buffer.concat([
        Buffer.from([0xde, 0xad, 0xad, 0xde]),
        nestedBlob(2, 3)
    ]);
    const r1 = await analyzeArtifact({ buffer: container, name: "det.bin" },
        { nowEpochMs: 0 });
    const r2 = await analyzeArtifact({ buffer: container, name: "det.bin" },
        { nowEpochMs: 0 });
    assert.deepStrictEqual(r1, r2);
    assert.equal(r1.workBudget.analysesUsedInTree, r2.workBudget.analysesUsedInTree);
});

test("B5: anggaran byte kumulatif menghentikan deep-parse anak, root tetap utuh", async () => {
    const inner = buildPe({});
    const container = Buffer.concat([
        Buffer.from([0xde, 0xad, 0xad, 0xde]),
        Buffer.alloc(600),
        inner
    ]);

    const report = await analyzeArtifact(
        { buffer: container, name: "big-tree.bin" },
        { overrides: { limits: { maxCumulativeAnalyzedBytes: 1024 } } });

    // Root (permintaan eksplisit pengguna) tetap dianalisis penuh...
    assert.ok(report.classification.type);
    // ...tapi beban anak dihentikan secara diagnostik:
    assert.ok(report.diagnostics.some((d) =>
        d.code === "BUDGET_LIMIT_REACHED" && /kumulatif/.test(d.message)));
    // laporan parsial tetap valid dan immutable:
    assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.throws(() => { report.diagnostics.push({}); }, TypeError);
});
