const path = require("node:path");
const fs = require("node:fs/promises");

/**
 * Ekstraksi teks dari berkas.
 *
 * Format teks ditangani langsung. PDF dan DOCX butuh pustaka
 * eksternal yang di-require secara malas: bila belum terpasang,
 * yang muncul adalah pesan jelas berisi perintah pemasangan,
 * bukan crash saat boot.
 */

const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".log", ".csv", ".tsv",
    ".json", ".yaml", ".yml", ".xml", ".html", ".htm",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp",
    ".go", ".rs", ".rb", ".php", ".sh", ".sql", ".ini", ".conf",
    ".env", ".toml"
]);

/** Format yang dikenali tapi belum didukung — dilaporkan apa adanya. */
const KNOWN_UNSUPPORTED = {
    ".xlsx": "spreadsheet",
    ".xls": "spreadsheet",
    ".pptx": "presentasi",
    ".ppt": "presentasi",
    ".doc": "Word format lama (.doc)"
};

async function extract(filePath) {

    const extension = path.extname(filePath).toLowerCase();

    const stat = await fs.stat(filePath);

    const base = {
        uri: filePath,
        title: path.basename(filePath),
        byteSize: stat.size,
        mediaType: extension.replace(".", "") || "unknown"
    };

    if (extension === ".pdf") {
        return { ...base, ...(await extractPdf(filePath)) };
    }

    if (extension === ".docx") {
        return { ...base, ...(await extractDocx(filePath)) };
    }

    if (extension === ".html" || extension === ".htm") {
        return { ...base, ...(await extractHtml(filePath)) };
    }

    if (TEXT_EXTENSIONS.has(extension) || extension === "") {
        return { ...base, content: await fs.readFile(filePath, "utf8") };
    }

    if (KNOWN_UNSUPPORTED[extension]) {

        throw new Error(
            `Format ${extension} (${KNOWN_UNSUPPORTED[extension]}) belum didukung. ` +
            `Ekspor ke PDF, DOCX, atau teks terlebih dahulu.`
        );

    }

    throw new Error(`Format berkas tidak dikenali: ${extension || "(tanpa ekstensi)"}`);

}

async function extractPdf(filePath) {

    let PDFParse;

    try {
        // pdf-parse v2 mengekspor kelas PDFParse, bukan fungsi
        // seperti v1 — pemanggilannya berbeda total.
        ({ PDFParse } = require("pdf-parse"));
    }
    catch {
        throw new Error(
            "Dukungan PDF butuh paket 'pdf-parse'. Jalankan: npm install pdf-parse"
        );
    }

    const buffer = await fs.readFile(filePath);

    const parser = new PDFParse({ data: new Uint8Array(buffer) });

    try {

        const [text, info] = await Promise.all([
            parser.getText(),
            parser.getInfo().catch(() => null)
        ]);

        return {
            content: normalizeWhitespace(
                stripPageMarkers(text?.text ?? "")
            ),
            metadata: {
                pages: text?.total ?? info?.total ?? null,
                pdfInfo: info?.info ?? null
            },
            title:
                info?.info?.Title?.trim() ||
                path.basename(filePath)
        };

    }

    finally {
        // Parser memegang worker; tanpa destroy, proses tidak keluar.
        await parser.destroy().catch(() => {});
    }

}

async function extractDocx(filePath) {

    let mammoth;

    try {
        mammoth = require("mammoth");
    }
    catch {
        throw new Error(
            "Dukungan DOCX butuh paket 'mammoth'. Jalankan: npm install mammoth"
        );
    }

    const result = await mammoth.extractRawText({ path: filePath });

    return {
        content: normalizeWhitespace(result.value),
        metadata: {
            warnings: (result.messages ?? []).map(message => message.message)
        }
    };

}

async function extractHtml(filePath) {

    const raw = await fs.readFile(filePath, "utf8");

    return { content: htmlToText(raw) };

}

/**
 * Pengupasan HTML sederhana. Cukup untuk halaman dokumentasi yang
 * disimpan lokal; skrip dan gaya dibuang lebih dulu agar isinya
 * tidak tercemar kode.
 */
function htmlToText(html) {

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];

    const body = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ");

    const decoded = body
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    return `${title ? `${title.trim()}\n\n` : ""}${normalizeWhitespace(decoded)}`;

}

/**
 * pdf-parse menyisipkan penanda halaman "-- 3 of 12 --".
 * Berguna untuk dibaca manusia, tetapi mengotori embedding dan
 * kutipan, jadi dibuang saat ingest.
 */
function stripPageMarkers(text) {

    return String(text ?? "")
        .replace(/^[ \t]*--\s*\d+\s+of\s+\d+\s*--[ \t]*$/gim, "");

}

function normalizeWhitespace(text) {

    return String(text ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

}

function isSupported(filePath) {

    const extension = path.extname(filePath).toLowerCase();

    return (
        extension === ".pdf" ||
        extension === ".docx" ||
        TEXT_EXTENSIONS.has(extension)
    );

}

module.exports = {
    extract,
    isSupported,
    htmlToText,
    normalizeWhitespace,
    TEXT_EXTENSIONS,
    KNOWN_UNSUPPORTED
};
