/**
 * RE Intelligence — mesin identifikasi artifact.
 *
 * Identifikasi berbasis BUKTI berlapis:
 *   1. Magic bytes (bukti terkuat)
 *   2. Struktur header (mis. validasi PE di balik MZ)
 *   3. Heuristik konten (teks-printable, shebang)
 *   4. Extension (BUKTI TERLEMAH — tidak pernah otoritatif)
 *
 * Extension yang bertentangan dengan magic TIDAK mengubah klasifikasi;
 * ketidaksesuaian dicatat sebagai evidence + finding. UNKNOWN adalah
 * hasil sah — klasifikasi tidak dipaksakan.
 */

"use strict";

const {
    ArtifactType, EvidenceKind, freezeDeep
} = require("../model/model");
const { looksLikePe } = require("./pe");
const { shannonEntropy } = require("./entropy");

const MAGIC_CHECKS = [
    { bytes: [0x4d, 0x5a], type: ArtifactType.PE_EXECUTABLE, label: "MZ" },
    { bytes: [0x7f, 0x45, 0x4c, 0x46], type: ArtifactType.ELF, label: "ELF" },
    { bytes: [0x50, 0x4b, 0x03, 0x04], type: ArtifactType.ARCHIVE, label: "zip-local-header" },
    { bytes: [0x50, 0x4b, 0x05, 0x06], type: ArtifactType.ARCHIVE, label: "zip-empty" },
    { bytes: [0x1f, 0x8b], type: ArtifactType.ARCHIVE, label: "gzip" },
    { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], type: ArtifactType.ARCHIVE, label: "7z" },
    { bytes: [0x52, 0x61, 0x72, 0x21], type: ArtifactType.ARCHIVE, label: "rar" }
];

// "!<arch>\n" (ar) dicek sebagai string; ustar pada offset 257.
function matchArMagic(buf) {
    return buf.length >= 8 && buf.toString("latin1", 0, 8) === "!<arch>\n";
}

function matchTarMagic(buf) {
    return buf.length >= 262 && buf.toString("latin1", 257, 262) === "ustar";
}

const SCRIPT_EXTENSIONS = new Set([
    ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".pl", ".sh", ".bash",
    ".ps1", ".bat", ".cmd", ".php", ".lua"
]);

const FIRMWARE_EXTENSIONS = new Set([".fw", ".rom", ".bin"]);

/**
 * Rasio byte printable-ASCII + whitespace lazim pada sampel.
 * Byte >= 0x80 sengaja TIDAK dihitung sebagai teks: konten biner
 * murni (mis. 0xCA 0xFE 0xBA 0xBE) tidak boleh terklasifikasi TEXT
 * hanya karena berada di rentang tinggi. Teks UTF-8 nyata tetap
 * lolos karena didominasi ASCII.
 */
function nonPrintableRatio(buf, maxBytes) {
    const n = Math.min(buf.length, maxBytes);
    if (n === 0) return 1;
    let nonText = 0;
    for (let i = 0; i < n; i++) {
        if (!isTextByte(buf[i])) nonText++;
    }
    return Math.round((nonText / n) * 1000) / 1000;
}

function isTextByte(b) {
    return (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d;
}

/**
 * Identifikasi artifact.
 * @param {Buffer} header - hingga maxHeaderBytes byte awal file.
 * @param {{name?: string, sizeBytes?: number}} meta
 */
function identifyArtifact(header, meta, limits, bands) {
    const evidence = [];
    let seq = 0;
    const ev = (kind, observation, extra = {}) => {
        evidence.push(freezeDeep({
            id: `ev-${String(++seq).padStart(4, "0")}`,
            source: "identification",
            kind,
            observation,
            ...extra
        }));
        return evidence[evidence.length - 1].id;
    };

    const ext = meta.name ? extensionOf(meta.name) : "";
    let type = ArtifactType.UNKNOWN;
    let score = 0;
    let basis = [];

    // ---- 1. Magic bytes ------------------------------------------------
    let magicHit = null;
    for (const m of MAGIC_CHECKS) {
        if (header.length >= m.bytes.length &&
            m.bytes.every((b, i) => header[i] === b)) {
            magicHit = m;
            break;
        }
    }
    if (!magicHit && matchArMagic(header)) {
        magicHit = { type: ArtifactType.ARCHIVE, label: "ar-archive" };
    }
    if (!magicHit && matchTarMagic(header)) {
        magicHit = { type: ArtifactType.ARCHIVE, label: "ustar-tar" };
    }

    if (magicHit?.label === "MZ") {
        if (looksLikePe(header)) {
            // Bedakan DLL vs EXE lewat karakteristik COFF (bit 0x2000).
            const lfaNew = header.readUInt32LE(0x3c);
            const characteristics = header.readUInt16LE(lfaNew + 4 + 18);
            const isDll = (characteristics & 0x2000) !== 0;
            type = isDll ? ArtifactType.PE_DLL : ArtifactType.PE_EXECUTABLE;
            score = 0.95;
            ev(EvidenceKind.MAGIC_BYTES, `magic MZ + signature PE valid (${type})`);
            ev(EvidenceKind.HEADER_FIELD,
                `COFF characteristics 0x${characteristics.toString(16)} → ${isDll ? "DLL" : "executable"}`);
        } else {
            type = ArtifactType.BINARY;
            score = 0.5;
            ev(EvidenceKind.MAGIC_BYTES,
                "magic MZ tanpa signature PE valid (DOS stub / self-extract?)");
        }
        basis.push("magic:MZ");
    } else if (magicHit) {
        type = magicHit.type;
        score = 0.9;
        basis.push(`magic:${magicHit.label}`);
        ev(EvidenceKind.MAGIC_BYTES, `magic bytes cocok ${magicHit.label} → ${type}`);
    }

    // ---- 2. Heuristik konten teks/skrip --------------------------------
    if (!magicHit || magicHit.label === "MZ") {
        const textish = header.length > 0 &&
            nonPrintableRatio(header, limits.maxHeaderBytes) <= 0.1;
        if (textish && type === ArtifactType.UNKNOWN) {
            const text = header.toString("utf8", 0,
                Math.min(header.length, limits.maxHeaderBytes));
            const hasShebang = text.startsWith("#!");
            const scriptExt = SCRIPT_EXTENSIONS.has(ext);
            if (hasShebang || scriptExt) {
                type = ArtifactType.SCRIPT;
                score = hasShebang ? 0.85 : 0.6;
                basis.push(hasShebang ? "content:shebang" : `extension:${ext}`);
                if (hasShebang) {
                    ev(EvidenceKind.CONTENT_HEURISTIC,
                        `shebang terdeteksi: ${firstLine(text)}`);
                }
                if (scriptExt) {
                    ev(EvidenceKind.EXTENSION,
                        `extension ${ext} dikenal sebagai skrip (bukti lemah)`);
                }
            } else {
                type = ArtifactType.TEXT;
                score = 0.8;
                basis.push("content:printable-text");
                ev(EvidenceKind.CONTENT_HEURISTIC,
                    "konten dominan printable text → TEXT");
            }
        } else if (!textish && type === ArtifactType.UNKNOWN) {
            // ---- 3. Firmware/blob lemah: extension hint + biner ------
            const entropy = shannonEntropy(header, limits.entropySampleBytes);
            ev(EvidenceKind.ENTROPY,
                `entropy sampel ${entropy} bit/byte`);
            if (FIRMWARE_EXTENSIONS.has(ext)) {
                type = ArtifactType.FIRMWARE_BLOB;
                score = 0.4;
                basis.push(`extension:${ext}`, "content:binary-no-magic");
                ev(EvidenceKind.EXTENSION,
                    `extension ${ext} mengindikasikan firmware (bukti lemah, bukan bukti struktur)`);
            } else {
                // Tanpa magic, tanpa teks, extension tak dikenal → biarkan
                // UNKNOWN. Klasifikasi tidak dipaksakan.
                type = ArtifactType.UNKNOWN;
                score = 0.05;
                basis.push("no-evidence");
                ev(EvidenceKind.CONTENT_HEURISTIC,
                    "tidak ada magic, bukan teks, tanpa extension yang bermakna → UNKNOWN");
            }
        }
    }

    // Extension selalu dicatat sebagai bukti (lemah), dan kontradiksi
    // extension-vs-klasifikasi wajib tampak.
    if (ext !== "" && magicHit) {
        const extImpliesText = isPlainTextExtension(ext);
        const contradicts =
            (extImpliesText && type !== ArtifactType.TEXT) ||
            (!extImpliesText && false);
        ev(EvidenceKind.EXTENSION,
            contradicts
                ? `extension "${ext}" TIDAK SESUAI dengan klasifikasi struktural ${type} — extension tidak otoritatif`
                : `extension "${ext}" (bukti sekunder)`);
        if (contradicts) {
            score = Math.min(score, 0.9); // tetap tinggi: struktur menang
        }
    }

    return freezeDeep({
        type,
        confidenceScore: score,
        basis,
        evidence,
        entropy: shannonEntropy(header, limits.entropySampleBytes),
        nonPrintableRatio: nonPrintableRatio(header, limits.maxHeaderBytes)
    });
}

function extensionOf(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

function isPlainTextExtension(ext) {
    return ext === ".txt" || ext === ".md" || ext === ".log" ||
        ext === ".json" || ext === ".xml" || SCRIPT_EXTENSIONS.has(ext);
}

function firstLine(text) {
    const line = text.split("\n", 1)[0];
    return line.length > 120 ? line.slice(0, 120) + "…" : line;
}

module.exports = { identifyArtifact };
