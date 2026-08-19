const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { SECRET_PATTERNS } = require("../coding/review/diffReviewer");

const pexec = promisify(execFile);
const OPTS = { timeout: 120000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };

/**
 * auditor — mesin audit keamanan (Aether sebagai insinyur keamanan).
 *
 * Tiga pemeriksaan yang paling sering menemukan kerusakan nyata dan
 * bisa dibuktikan tanpa menebak: rahasia yang ter-commit, dependensi
 * berkerentanan diketahui, dan pola kode berbahaya. Semua BERBASIS
 * BUKTI — tiap temuan menunjuk berkas & baris, bukan kesan.
 *
 * Bukan pemindai target pihak ketiga: yang diperiksa adalah kode dan
 * dependensi milik pemilik. Pengujian terhadap sistem orang lain
 * butuh izin, dan itu urusan pemiliknya, bukan diputuskan di sini.
 */

/** Berkas yang tak layak dipindai baris demi baris. */
const LEWATI_DIR = /(^|[\\/])(node_modules|\.git|dist|build|coverage|graphify-out|\.next|vendor)([\\/]|$)/;
const LEWATI_EXT = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
    ".mp3", ".mp4", ".mov", ".wav", ".woff", ".woff2", ".ttf", ".exe", ".dll", ".db",
    ".sqlite", ".sqlite3", ".lock"
]);
const MAKS_BYTE = 512 * 1024;

/**
 * Pola kode berbahaya. Sengaja sedikit dan tajam: aturan yang sering
 * salah tuduh membuat seluruh laporan diabaikan.
 */
const CODE_RULES = [
    {
        rule: "eksekusi-dinamis", severity: "tinggi",
        pola: [/\beval\s*\(/, /\bnew\s+Function\s*\(/],
        catatan: "Eksekusi kode dinamis — bila masukan bisa dipengaruhi pengguna, ini RCE. Ganti dengan parser/whitelist."
    },
    {
        rule: "injeksi-perintah", severity: "tinggi",
        pola: [/\bexec(Sync)?\s*\(\s*[`"'][^`"')]*\$\{/, /\bexec(Sync)?\s*\([^)]*\+\s*(req|input|user|arg)/i],
        catatan: "Perintah shell dirangkai dari variabel — pakai execFile/spawn dengan array argumen, jangan string."
    },
    {
        rule: "injeksi-sql", severity: "tinggi",
        pola: [/(SELECT|INSERT|UPDATE|DELETE)\b[^;`"']*\$\{/i, /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*["']\s*\+\s*\w+/i],
        catatan: "Query dirangkai dari variabel — pakai parameter terikat (prepared statement)."
    },
    {
        rule: "tls-dimatikan", severity: "tinggi",
        pola: [/rejectUnauthorized\s*:\s*false/, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/],
        catatan: "Verifikasi sertifikat dimatikan — koneksi terbuka untuk penyadapan aktif (MITM)."
    },
    {
        rule: "traversal-path", severity: "sedang",
        pola: [/path\.(join|resolve)\s*\([^)]*\b(req|request|params|query|body)\b/],
        catatan: "Jalur berkas dibentuk dari masukan pengguna — normalisasi lalu pastikan hasilnya di dalam direktori izin."
    },
    {
        rule: "kripto-lemah", severity: "sedang",
        pola: [/createHash\s*\(\s*["'](md5|sha1)["']/i],
        catatan: "MD5/SHA-1 sudah patah untuk keperluan keamanan — pakai SHA-256, dan bcrypt/scrypt/argon2 untuk kata sandi."
    },
    {
        rule: "acak-tidak-aman", severity: "sedang",
        pola: [/Math\.random\s*\(\)/],
        hanyaBila: /\b(token|secret|password|sandi|otp|nonce|kunci|key|session)\b/i,
        catatan: "Math.random bukan acak kriptografis — pakai crypto.randomUUID() atau crypto.randomBytes()."
    },
    {
        rule: "xss-dom", severity: "sedang",
        pola: [/\.innerHTML\s*=/, /dangerouslySetInnerHTML/],
        catatan: "HTML disuntik langsung ke DOM — pakai textContent, atau sanitasi bila HTML memang diperlukan."
    },
    {
        rule: "cors-terbuka", severity: "rendah",
        pola: [/origin\s*:\s*["']\*["']/, /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']/],
        catatan: "CORS terbuka untuk semua asal — batasi ke daftar asal yang dikenal bila endpoint memakai kredensial."
    }
];

/**
 * Placeholder di berkas contoh dan fixture uji BUKAN kebocoran.
 *
 * Melaporkannya setara kunci sungguhan membuat laporan penuh alarm
 * palsu — dan laporan yang penuh alarm palsu berhenti dibaca, persis
 * saat kunci asli muncul di dalamnya.
 */
const BERKAS_CONTOH = /(^|\/)(tests?|__tests__|__fixtures__|examples?|docs?)\//i;
const NAMA_CONTOH = /\.(example|sample|template|dist)(\.\w+)?$|\.md$/i;
const NILAI_CONTOH = /\b(ganti|contoh|example|sample|dummy|placeholder|your[_-]?|xxx+|change[_-]?me|uji|test|fake)\b/i;

function kemungkinanContoh(file, teks) {
    return BERKAS_CONTOH.test(file) || NAMA_CONTOH.test(file) || NILAI_CONTOH.test(teks);
}

/** Temuan berat lebih dulu — kuota tidak boleh dihabiskan temuan ringan. */
const PERINGKAT = { tinggi: 0, sedang: 1, rendah: 2 };

function urutkan(findings) {
    return findings.sort((a, b) =>
        PERINGKAT[a.severity] - PERINGKAT[b.severity] ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
}

function bolehDipindai(file) {
    if (LEWATI_DIR.test(file)) return false;
    if (LEWATI_EXT.has(path.extname(file).toLowerCase())) return false;
    return true;
}

/** Daftar berkas terlacak git; jatuh ke penelusuran folder bila bukan repo. */
async function daftarBerkas(project) {

    try {
        const { stdout } = await pexec("git", ["ls-files"], { ...OPTS, cwd: project });
        const files = stdout.split(/\r?\n/).filter(Boolean);
        if (files.length) return files;
    }
    catch { /* bukan repo git — telusuri manual */ }

    const out = [];

    (function walk(dir, rel = "") {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (LEWATI_DIR.test(r)) continue;
            if (e.isDirectory()) walk(path.join(dir, e.name), r);
            else out.push(r);
        }
    })(project);

    return out;

}

function bacaBaris(project, file) {
    const abs = path.join(project, file);
    try {
        if (fs.statSync(abs).size > MAKS_BYTE) return null;
        return fs.readFileSync(abs, "utf8").split(/\r?\n/);
    }
    catch { return null; }
}

/**
 * Pindai rahasia yang ter-commit (kunci API, token, private key).
 *
 * Yang ditemukan di sini berarti rahasianya SUDAH ada di riwayat git:
 * menghapus barisnya tidak cukup, kuncinya harus dicabut.
 */
async function scanSecrets(project = process.cwd(), { maxTemuan = 50 } = {}) {

    const files = (await daftarBerkas(project)).filter(bolehDipindai);
    const findings = [];

    for (const file of files) {
        const baris = bacaBaris(project, file);
        if (!baris) continue;
        for (let i = 0; i < baris.length; i++) {
            if (SECRET_PATTERNS.some(p => p.test(baris[i]))) {
                const contoh = kemungkinanContoh(file, baris[i]);
                findings.push({
                    severity: contoh ? "rendah" : "tinggi",
                    rule: contoh ? "rahasia-contoh" : "rahasia",
                    file, line: i + 1,
                    teks: baris[i].trim().slice(0, 120),
                    catatan: contoh
                        ? "Tampak placeholder/fixture uji — periksa sekilas, bukan kunci sungguhan."
                        : "Rahasia ada di dalam repo — CABUT kuncinya lalu pindahkan ke .env (dan .env harus gitignored)."
                });
                if (findings.length >= maxTemuan) break;
            }
        }
        if (findings.length >= maxTemuan) break;
    }

    const sungguhan = findings.filter(f => f.rule === "rahasia").length;

    return {
        ok: sungguhan === 0,
        dipindai: files.length,
        findings: urutkan(findings),
        ringkasan:
            `${files.length} berkas dipindai, ${sungguhan} dugaan rahasia sungguhan ` +
            `(+${findings.length - sungguhan} placeholder/uji).`
    };

}

/** Audit pola kode berbahaya (SAST ringan, berbasis bukti baris). */
async function auditCode(project = process.cwd(), { files, maxTemuan = 60 } = {}) {

    const daftar = (files?.length ? files : await daftarBerkas(project))
        .filter(bolehDipindai)
        .filter(f => /\.(js|cjs|mjs|ts|tsx|jsx)$/i.test(f));

    const findings = [];

    for (const file of daftar) {
        const baris = bacaBaris(project, file);
        if (!baris) continue;
        for (let i = 0; i < baris.length; i++) {
            const teks = baris[i];
            for (const r of CODE_RULES) {
                if (r.hanyaBila && !r.hanyaBila.test(teks)) continue;
                if (r.pola.some(p => p.test(teks))) {
                    findings.push({
                        severity: r.severity, rule: r.rule, file, line: i + 1,
                        teks: teks.trim().slice(0, 160), catatan: r.catatan
                    });
                    break;
                }
            }
        }
    }

    const tinggi = findings.filter(f => f.severity === "tinggi").length;

    // Pemotongan dilakukan SESUDAH diurutkan menurut tingkat. Dipotong
    // saat memindai membuat satu aturan cerewet (mis. innerHTML) menghabiskan
    // kuota dan menyembunyikan temuan tinggi di berkas berikutnya —
    // laporan lengkap yang menutupi RCE lebih buruk daripada tak ada.
    const urut = urutkan(findings);
    const dipangkas = urut.length > maxTemuan;

    return {
        ok: tinggi === 0,
        dipindai: daftar.length,
        findings: dipangkas ? urut.slice(0, maxTemuan) : urut,
        dipangkas,
        ringkasan:
            `${daftar.length} berkas kode, ${findings.length} temuan ` +
            `(${tinggi} tinggi)${dipangkas ? `, ditampilkan ${maxTemuan} terberat` : ""}.`
    };

}

/**
 * Kerentanan dependensi lewat `npm audit`.
 *
 * Kegagalan TIDAK ditelan: tanpa jaringan atau tanpa lockfile, hasilnya
 * "tidak diketahui" — bukan "aman". Melaporkan aman padahal audit tak
 * pernah jalan adalah kebohongan yang paling mahal di sini.
 */
async function auditDeps(project = process.cwd()) {

    if (!fs.existsSync(path.join(project, "package.json"))) {
        return { ok: false, note: "Tak ada package.json — bukan proyek Node." };
    }

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    let raw;

    try {
        const { stdout } = await pexec(npm, ["audit", "--json"], { ...OPTS, cwd: project });
        raw = stdout;
    }
    catch (e) {
        // npm audit keluar dengan kode ≠ 0 justru KETIKA ada kerentanan;
        // stdout-nya tetap JSON yang sah, jadi dipakai bila ada.
        raw = e.stdout;
        if (!raw) return { ok: false, note: `npm audit gagal: ${(e.stderr || e.message || "").slice(-500)}` };
    }

    let data;
    try { data = JSON.parse(raw); }
    catch { return { ok: false, note: "Keluaran npm audit bukan JSON yang bisa dibaca." }; }

    const meta = data.metadata?.vulnerabilities ?? {};

    const paket = Object.entries(data.vulnerabilities ?? {})
        .map(([nama, v]) => ({
            paket: nama,
            severity: v.severity,
            via: (Array.isArray(v.via) ? v.via : []).map(x => (typeof x === "string" ? x : x?.title)).filter(Boolean).slice(0, 2),
            perbaikanTersedia: !!v.fixAvailable
        }))
        .filter(p => ["critical", "high", "moderate"].includes(p.severity))
        .slice(0, 25);

    const berat = (meta.critical ?? 0) + (meta.high ?? 0);

    return {
        ok: berat === 0,
        total: meta,
        paket,
        ringkasan: `kritis ${meta.critical ?? 0}, tinggi ${meta.high ?? 0}, sedang ${meta.moderate ?? 0}, rendah ${meta.low ?? 0}.`
    };

}

module.exports = { scanSecrets, auditCode, auditDeps, CODE_RULES };
