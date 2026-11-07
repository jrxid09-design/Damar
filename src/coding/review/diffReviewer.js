const path = require("node:path");

/**
 * diffReviewer — tinjauan mekanis atas diff sebelum commit.
 *
 * Bukan pengganti penilaian Damar: ini menangkap hal yang mesin
 * lebih andal melihatnya daripada model yang membaca ratusan baris —
 * rahasia yang ikut terbawa, sisa kode debug, perubahan logika tanpa
 * test. Temuan dikembalikan dengan nomor baris agar bisa ditindak,
 * bukan sekadar "sepertinya ada masalah".
 */

/**
 * Aturan dijalankan HANYA pada baris yang DITAMBAH. Baris yang
 * dihapus tidak relevan: menghapus console.log bukan temuan.
 */
const RULES = [
    {
        rule: "rahasia",
        level: "blok",
        catatan: "Kredensial tampak ikut ter-commit — pindahkan ke .env dan cabut kuncinya.",
        pola: [
            /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
            /\bsk-[A-Za-z0-9_-]{16,}/,
            /\bAKIA[0-9A-Z]{16}\b/,
            /\bgh[pousr]_[A-Za-z0-9]{20,}/,
            /(api[_-]?key|secret|token|password|passwd|passphrase)\s*[:=]\s*["'][^"'\s]{8,}["']/i
        ]
    },
    {
        rule: "debug",
        level: "peringatan",
        catatan: "Sisa kode debug — buang sebelum commit.",
        pola: [/\bconsole\.log\s*\(/, /\bdebugger\b/, /\.only\s*\(/]
    },
    {
        rule: "tertunda",
        level: "peringatan",
        catatan: "Pekerjaan yang ditunda di dalam patch — selesaikan atau catat sebagai isu.",
        pola: [/\b(TODO|FIXME|XXX|HACK)\b/]
    }
];

/** Ambang diff yang terlalu besar untuk ditinjau dengan jujur. */
const BESAR = 400;

/**
 * Pecah diff unified jadi { file, baris:[{ no, teks }] } untuk baris
 * yang ditambah. Nomor baris dihitung dari header hunk (@@) supaya
 * temuan menunjuk ke tempat nyata di file baru.
 */
function parseDiff(diff) {

    const files = new Map();
    let file = null;
    let no = 0;

    for (const line of String(diff || "").split(/\r?\n/)) {

        const b = /^\+\+\+ b\/(.+)$/.exec(line);
        if (b) { file = b[1] === "dev/null" ? null : b[1]; if (file) files.set(file, []); continue; }

        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { no = Number(hunk[1]); continue; }

        if (!file) continue;

        if (line.startsWith("+")) { files.get(file).push({ no, teks: line.slice(1) }); no++; }
        else if (!line.startsWith("-") && !line.startsWith("\\")) { no++; }

    }

    return files;

}

const KODE = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".ps1"]);

function berkasTest(file) {
    return /(^|\/)(tests?|__tests__|spec)\//i.test(file) || /\.(test|spec)\.[a-z]+$/i.test(file);
}

/**
 * Tinjau sebuah diff unified. Balikan { findings, ringkasan } —
 * `ok` di sini berarti "tak ada temuan tingkat blok", bukan
 * "sudah pasti benar"; benar/tidaknya tetap dinilai oleh test.
 */
function review(diff, { maxTemuan = 40 } = {}) {

    const files = parseDiff(diff);
    const findings = [];

    let ditambah = 0;
    let kodeBerubah = false;
    let testBerubah = false;

    for (const [file, baris] of files) {

        ditambah += baris.length;

        const ext = path.extname(file).toLowerCase();
        if (KODE.has(ext)) { if (berkasTest(file)) testBerubah = true; else kodeBerubah = true; }

        if (baris.length > BESAR) {
            findings.push({
                level: "peringatan", rule: "diff-besar", file, line: 0,
                teks: `${baris.length} baris ditambah`,
                catatan: "Terlalu besar untuk ditinjau sekali jalan — pecah jadi beberapa commit."
            });
        }

        for (const { no, teks } of baris) {
            for (const r of RULES) {
                if (r.pola.some(p => p.test(teks))) {
                    findings.push({
                        level: r.level, rule: r.rule, file, line: no,
                        teks: teks.trim().slice(0, 200), catatan: r.catatan
                    });
                    break;                                   // satu temuan per baris sudah cukup
                }
            }
        }

    }

    if (kodeBerubah && !testBerubah) {
        findings.push({
            level: "peringatan", rule: "tanpa-test", file: "(diff)", line: 0,
            teks: "logika berubah, tak ada berkas test yang ikut berubah",
            catatan: "Logika non-sepele meninggalkan satu pemeriksaan yang bisa dijalankan."
        });
    }

    const dipangkas = findings.length > maxTemuan;

    return {
        ok: !findings.some(f => f.level === "blok"),
        files: [...files.keys()],
        ditambah,
        findings: dipangkas ? findings.slice(0, maxTemuan) : findings,
        dipangkas,
        ringkasan:
            `${files.size} berkas, +${ditambah} baris, ${findings.length} temuan ` +
            `(${findings.filter(f => f.level === "blok").length} blok).`
    };

}

module.exports = {
    review,
    parseDiff,
    /** Dipakai ulang oleh audit keamanan — satu daftar pola rahasia, bukan dua. */
    SECRET_PATTERNS: RULES.find(r => r.rule === "rahasia").pola
};
