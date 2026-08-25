/**
 * RE Intelligence — analyzer bawaan V0.
 *
 * Semua analyzer murni statis: membaca byte yang sudah ada di memori,
 * tidak mengeksekusi apa pun, tidak membaca file lain di luar artifact
 * yang dianalisis. Setiap temuan merujuk ID bukti yang menghasilkannya.
 */

"use strict";

const {
    ArtifactType, EvidenceKind, RelationshipType,
    AnalysisStage, makeConfidence
} = require("../model/model");
const { parsePe, looksLikePeAt } = require("../core/pe");
const { extractStrings } = require("../core/strings");
const { analyzeScript } = require("../core/scripts");
const { defineAnalyzer } = require("./analyzer");

// ---------------------------------------------------------------------
// PE static analyzer
// ---------------------------------------------------------------------
const peAnalyzer = defineAnalyzer({
    id: "pe-static",
    version: 1,
    supports: (ctx) =>
        ctx.buffer !== null &&
        (ctx.descriptor.type === ArtifactType.PE_EXECUTABLE ||
         ctx.descriptor.type === ArtifactType.PE_DLL),
    analyze: (ctx) => {
        const parsed = parsePe(ctx.buffer, ctx.limits);

        if (!parsed.ok) {
            for (const d of parsed.diagnostics) {
                ctx.addDiagnostic(d.code, d.message, "warning");
            }
            ctx.addHypothesis(
                "artifact berklaim PE tetapi struktur tidak dapat diparse — kemungkinan korup, terpotong, atau bukan PE sungguhan",
                [ctx.addEvidence({
                    source: "pe-static",
                    kind: EvidenceKind.HEADER_FIELD,
                    observation: "PE signature gagal divalidasi penuh"
                })],
                makeConfidence(0.5, ctx.bands)
            );
            ctx.suggestStage(AnalysisStage.DEEP_PE_ANALYSIS);
            return;
        }

        // ---- fakta struktural ------------------------------------------
        const evArch = ctx.addEvidence({
            source: "pe-static",
            kind: EvidenceKind.HEADER_FIELD,
            observation: `arsitektur machine=0x${parsed.machineRaw.toString(16)} (${parsed.architecture}), optional header ${parsed.pe32Plus ? "PE32+" : "PE32"}`
        });
        ctx.addObservedFact(
            `binary ${parsed.architecture} (${parsed.isDll ? "DLL" : "executable"}, subsystem ${parsed.subsystem})`,
            [evArch], 0.95
        );

        const ep = parsed.entryPoint;
        const evEp = ctx.addEvidence({
            source: "pe-static",
            kind: EvidenceKind.HEADER_FIELD,
            observation: `entry point RVA 0x${ep.toString(16)}, image base ${parsed.imageBase}`
        });
        ctx.addObservedFact(`entry point RVA 0x${ep.toString(16)}`, [evEp]);

        // Timestamp = metadata saja, BUKAN kronologi tepercaya.
        const evTs = ctx.addEvidence({
            source: "pe-static",
            kind: EvidenceKind.HEADER_FIELD,
            observation: `field timestamp COFF = ${parsed.timestampField} (metadata; dapat dipalsukan, bukan bukti waktu kompilasi)`
        });

        const evSec = ctx.addEvidence({
            source: "pe-static",
            kind: EvidenceKind.SECTION_TABLE,
            observation: `${parsed.sections.length} section: ${parsed.sections.map((s) => s.name).join(", ")}`
        });
        ctx.addObservedFact(
            `section table berisi ${parsed.sections.length} section`,
            [evSec]
        );

        // ---- imports ----------------------------------------------------
        // DATA TERSTRUKTUR adalah sumber otoritatif inferensi; observation
        // hanyalah tampilan. Nama DLL/fungsi dengan delimiter palsu tetap
        // satu field literal dan tidak bisa menciptakan import tambahan.
        const importEvidenceIds = [];
        for (const imp of parsed.imports) {
            const id = ctx.addEvidence({
                source: "pe-static",
                kind: EvidenceKind.IMPORT_TABLE,
                observation: `imports ${imp.dll}: ${imp.functions.join(", ") || "(kosong)"}`,
                structured: {
                    kind: "pe_imports",
                    dll: imp.dll,
                    functions: [...imp.functions]
                }
            });
            importEvidenceIds.push(id);
            ctx.addRelationship({
                type: RelationshipType.IMPORTS,
                target: imp.dll.toLowerCase(),
                note: `${imp.functions.length} fungsi`
            });
        }
        if (importEvidenceIds.length) {
            ctx.addObservedFact(
                `tabel import memuat ${importEvidenceIds.length} DLL`,
                importEvidenceIds
            );
        }

        // ---- exports ----------------------------------------------------
        if (parsed.exports.dllName !== null && parsed.exports.functions.length) {
            const id = ctx.addEvidence({
                source: "pe-static",
                kind: EvidenceKind.EXPORT_TABLE,
                observation: `exports (${parsed.exports.dllName}): ${parsed.exports.functions.slice(0, 20).join(", ")}${parsed.exports.truncated ? " …(terpotong budget)" : ""}`
            });
            ctx.addObservedFact(
                `mengekspor ${parsed.exports.functions.length} simbol${parsed.exports.truncated ? " (terpotong)" : ""}`,
                [id]
            );
        }

        // ---- anomali struktural → inferred + hypothesis -----------------
        const anomalies = [];
        for (const s of parsed.sections) {
            if (s.beyondEof) {
                const id = ctx.addEvidence({
                    source: "pe-static",
                    kind: EvidenceKind.SECTION_TABLE,
                    observation: `section "${s.name}" raw data melewati akhir file (pointerToRawData=${s.pointerToRawData}, sizeOfRawData=${s.sizeOfRawData})`
                });
                ctx.addInferredClaim(
                    `struktur section "${s.name}" tidak konsisten dengan ukuran file — indikasi korupsi atau packing`,
                    [id],
                    makeConfidence(0.55, ctx.bands)
                );
                anomalies.push(s.name);
            }
            if (s.flags.includes("EXECUTE") && s.flags.includes("WRITE")) {
                const id = ctx.addEvidence({
                    source: "pe-static",
                    kind: EvidenceKind.SECTION_TABLE,
                    observation: `section "${s.name}" writable sekaligus executable (${s.flags.join("|")})`
                });
                ctx.addInferredClaim(
                    `memiliki section writable+executable — pola yang umum pada packer/pengecualian runtime, layak diperiksa lanjut`,
                    [id],
                    makeConfidence(0.5, ctx.bands)
                );
                anomalies.push(s.name);
            }
        }

        for (const d of parsed.diagnostics) {
            ctx.addDiagnostic(d.code, d.message,
                d.code === "BUDGET_LIMIT_REACHED" ? "warning" : "info");
        }

        if (anomalies.length || parsed.diagnostics.some((d) => d.code.startsWith("PE_"))) {
            ctx.suggestStage(AnalysisStage.DEEP_PE_ANALYSIS);
        }
    }
});

// ---------------------------------------------------------------------
// Script/text analyzer
// ---------------------------------------------------------------------
const scriptAnalyzer = defineAnalyzer({
    id: "script-static",
    version: 1,
    supports: (ctx) =>
        ctx.buffer !== null &&
        (ctx.descriptor.type === ArtifactType.SCRIPT ||
         ctx.descriptor.type === ArtifactType.TEXT),
    analyze: (ctx) => {
        const res = analyzeScript(ctx.buffer, ctx.limits);

        if (res.languageHint) {
            const id = ctx.addEvidence({
                source: "script-static",
                kind: EvidenceKind.CONTENT_HEURISTIC,
                observation: `hint bahasa: ${res.languageHint}`
            });
            ctx.addObservedFact(`bahasa skrip terindikasi ${res.languageHint}`, [id]);
        }

        // Kategori TERSTRUKTUR adalah sumber inferensi; observation string
        // hanya tampilan. URL untuk relasi REFERENCES juga diambil dari
        // data terstruktur (bukan parsing ulang string tampilan).
        for (const cat of res.categories) {
            const id = ctx.addEvidence({
                source: "script-static",
                kind: EvidenceKind.SCRIPT_PATTERN,
                observation:
                    `${cat.category}: ${cat.hits.map((h) => h.match).join(", ")}`,
                location: { lines: cat.hits.slice(0, 5).map((h) => h.line) },
                structured: {
                    kind: "script_pattern_category",
                    category: cat.category,
                    matches: cat.hits.map((h) => h.match)
                }
            });
            if (cat.category === "url_reference") {
                for (const h of cat.hits) {
                    if (/^https?:\/\//.test(h.match)) {
                        ctx.addRelationship({
                            type: RelationshipType.REFERENCES,
                            target: h.match,
                            note: "URL literal dalam skrip"
                        });
                    }
                }
            }
        }
    }
});

// ---------------------------------------------------------------------
// Strings extractor (untuk artifact biner)
// ---------------------------------------------------------------------
const STRINGS_TYPES = new Set([
    ArtifactType.PE_EXECUTABLE, ArtifactType.PE_DLL, ArtifactType.ELF,
    ArtifactType.ARCHIVE, ArtifactType.FIRMWARE_BLOB, ArtifactType.BINARY,
    ArtifactType.UNKNOWN
]);

const stringsAnalyzer = defineAnalyzer({
    id: "strings-extractor",
    version: 1,
    supports: (ctx) => ctx.buffer !== null && STRINGS_TYPES.has(ctx.descriptor.type),
    analyze: (ctx) => {
        const res = extractStrings(ctx.buffer, ctx.limits);
        const MAX_STORED = Math.min(res.strings.length, 100);
        const ids = [];
        for (let i = 0; i < MAX_STORED; i++) {
            ids.push(ctx.addEvidence({
                source: "strings-extractor",
                kind: EvidenceKind.STRING_LITERAL,
                observation: res.strings[i].value.slice(0, ctx.limits.maxEvidenceLiteralChars),
                location: { offset: res.strings[i].offset, encoding: res.strings[i].encoding }
            }));
        }
        if (res.strings.length) {
            ctx.addObservedFact(
                `${res.strings.length} printable string terekstrak (${res.truncated ? "dipotong oleh anggaran" : "lengkap"})`,
                ids.slice(0, 3)
            );
        }
        if (res.truncated) {
            ctx.addDiagnostic("BUDGET_LIMIT_REACHED",
                `pemindaian string berhenti pada ${res.scannedBytes} byte / ${ctx.limits.maxStrings} string`,
                "warning");
        }
    }
});

// ---------------------------------------------------------------------
// Embedded artifact scanner (bounded signature scan)
// ---------------------------------------------------------------------
const SCAN_TYPES = new Set([
    ArtifactType.ARCHIVE, ArtifactType.FIRMWARE_BLOB,
    ArtifactType.BINARY, ArtifactType.UNKNOWN
]);

const embeddedScanner = defineAnalyzer({
    id: "embedded-scanner",
    version: 1,
    supports: (ctx) => ctx.buffer !== null && SCAN_TYPES.has(ctx.descriptor.type),
    analyze: (ctx) => {
        const buf = ctx.buffer;
        const stride = 1;                   // pindai rapat; anggaran dijaga
        let found = 0;                      // oleh maxEmbeddedArtifacts

        for (let off = 0; off + 4 <= buf.length; off += stride) {
            // ZIP local header
            if (buf[off] === 0x50 && buf[off + 1] === 0x4b &&
                buf[off + 2] === 0x03 && buf[off + 3] === 0x04) {
                const emb = ctx.addEmbedded({
                    offset: off,
                    typeGuess: ArtifactType.ARCHIVE,
                    signal: "zip-local-header"
                });
                if (!emb) break;
                found++;
                continue;
            }
            // ELF
            if (buf[off] === 0x7f && buf[off + 1] === 0x45 &&
                buf[off + 2] === 0x4c && buf[off + 3] === 0x46) {
                const emb = ctx.addEmbedded({
                    offset: off,
                    typeGuess: ArtifactType.ELF,
                    signal: "elf-magic"
                });
                if (!emb) break;
                found++;
                continue;
            }
            // MZ — hanya dihitung jika lolos validasi PE ringan.
            if (buf[off] === 0x4d && buf[off + 1] === 0x5a && off + 0x40 <= buf.length) {
                if (looksLikePeAt(buf, off)) {
                    const emb = ctx.addEmbedded({
                        offset: off,
                        typeGuess: ArtifactType.PE_EXECUTABLE,
                        signal: "mz-pe-signature"
                    });
                    if (!emb) break;
                    found++;
                }
            }
        }

        if (found > 0) {
            ctx.addObservedFact(
                `${found} kandidat embedded artifact terdeteksi`,
                [ctx.addEvidence({
                    source: "embedded-scanner",
                    kind: EvidenceKind.CONTENT_HEURISTIC,
                    observation: `${found} signature embedded ditemukan pada stride ${stride}`
                })]
            );
        }
    }
});

module.exports = { defaultAnalyzers: [peAnalyzer, scriptAnalyzer, stringsAnalyzer, embeddedScanner] };
