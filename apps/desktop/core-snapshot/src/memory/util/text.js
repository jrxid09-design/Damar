const crypto = require("node:crypto");

/**
 * Kata umum bahasa Indonesia + Inggris yang tidak membantu
 * pencocokan. Dipakai untuk membersihkan query FTS, bukan untuk
 * mengubah isi memori.
 */
const STOPWORDS = new Set([
    "yang", "dan", "di", "ke", "dari", "untuk", "pada", "dengan",
    "adalah", "itu", "ini", "ada", "tidak", "atau", "saya", "kamu",
    "dia", "kita", "kami", "akan", "sudah", "juga", "bisa", "saja",
    "apa", "siapa", "kapan", "dimana", "bagaimana", "kenapa",
    "the", "a", "an", "of", "to", "in", "is", "are", "and", "or",
    "for", "on", "with", "what", "who", "when", "where", "how"
]);

/**
 * Bentuk kanonik sebuah nama: huruf kecil, tanpa diakritik,
 * tanpa tanda baca, spasi tunggal.
 *
 * Ini yang membuat "Honda  Vario!", "honda vario", dan
 * "Hondá Vario" dianggap entitas yang sama.
 */
function normalize(value) {

    return String(value ?? "")
        .normalize("NFD")
        // Buang tanda diakritik gabungan hasil dekomposisi NFD.
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

}

/** Normalisasi khusus plat nomor: buang spasi dan strip. */
function normalizePlate(value) {

    return String(value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

}

function hash(value) {

    return crypto
        .createHash("sha256")
        .update(String(value ?? ""), "utf8")
        .digest("hex");

}

/**
 * Klitik dan akhiran umum bahasa Indonesia.
 *
 * "motornya" harus bisa menemukan "motor", dan pencarian vektor
 * tidak selalu tersedia (embedding opsional), jadi pemenggalan
 * ringan ini menutup celah paling sering terjadi tanpa perlu
 * stemmer penuh.
 */
const CLITICS = ["nya", "ku", "mu", "lah", "kah", "pun", "kan"];

function stripClitic(token) {

    for (const clitic of CLITICS) {

        if (token.length > clitic.length + 3 && token.endsWith(clitic)) {
            return token.slice(0, -clitic.length);
        }

    }

    return null;

}

function tokens(value) {

    return normalize(value)
        .split(" ")
        .filter(token => token.length > 1 && !STOPWORDS.has(token));

}

/** Token beserta bentuk dasarnya, tanpa duplikat. */
function expandedTokens(value) {

    const result = [];

    const seen = new Set();

    for (const token of tokens(value)) {

        for (const variant of [token, stripClitic(token)]) {

            if (variant && !seen.has(variant)) {
                seen.add(variant);
                result.push(variant);
            }

        }

    }

    return result;

}

/**
 * Susun query FTS5 yang aman.
 *
 * Teks pengguna tidak boleh masuk mentah ke MATCH: tanda seperti
 * `"`, `*`, `NEAR`, atau `-` adalah operator FTS dan akan membuat
 * query gagal atau berarti lain. Tiap token dikutip sebagai frasa
 * literal lalu digabung dengan OR.
 */
function toMatchQuery(value, { prefix = true, expand = true } = {}) {

    const list = expand ? expandedTokens(value) : tokens(value);

    if (list.length === 0) {
        return null;
    }

    return list
        .map(token =>
            prefix && token.length >= 3
                ? `"${token}"*`
                : `"${token}"`)
        .join(" OR ");

}

/** Potong teks pada batas kata, untuk ringkasan/pratinjau. */
function truncate(value, limit = 220) {

    const text = String(value ?? "").trim();

    if (text.length <= limit) {
        return text;
    }

    const cut = text.slice(0, limit);

    const lastSpace = cut.lastIndexOf(" ");

    return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;

}

module.exports = {
    STOPWORDS,
    CLITICS,
    normalize,
    normalizePlate,
    hash,
    tokens,
    expandedTokens,
    stripClitic,
    toMatchQuery,
    truncate
};
