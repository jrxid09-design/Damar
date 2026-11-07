const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const pexec = promisify(execFile);

/** Folder cache media terunduh. */
const CACHE_DIR = path.join(os.tmpdir(), "damar-media");

/** Batas total cache. Di atas ini, berkas TERLAMA dihapus. */
const CACHE_CAP_BYTES = 500 * 1024 * 1024;   // 500 MB

/**
 * Jaga cache tak membengkak: bila total > 500 MB, hapus berkas paling
 * lama dipakai sampai kembali di bawah batas. Dipanggil tiap unduhan
 * baru. Berkas cache ada di folder Temp OS, jadi juga ikut terbersihkan
 * saat pembersihan Temp sistem — ini hanya menahan pertumbuhannya di
 * antara itu supaya penyimpanan pengguna tidak diam-diam menumpuk.
 */
function pruneCache() {
    try {
        const files = fs.readdirSync(CACHE_DIR)
            .map(f => {
                const p = path.join(CACHE_DIR, f);
                const s = fs.statSync(p);
                return { p, size: s.size, mtime: s.mtimeMs };
            })
            .sort((a, b) => a.mtime - b.mtime);   // terlama dulu

        let total = files.reduce((n, f) => n + f.size, 0);

        for (const f of files) {
            if (total <= CACHE_CAP_BYTES) break;
            try { fs.unlinkSync(f.p); total -= f.size; } catch { /* terpakai */ }
        }
    }
    catch { /* folder belum ada → tak ada yang dipangkas */ }
}

/**
 * Resolusi URL stream media LANGSUNG dengan yt-dlp.
 *
 * Kenapa: embed YouTube di dalam Electron rapuh (error 153 / "this
 * video is unavailable") walau videonya main di browser biasa —
 * kebijakan embed + UA webview. Alih-alih menyematkan player YouTube,
 * kita ambil URL stream progresif (itag 18: satu berkas mp4 berisi
 * audio+video) lalu memutarnya di elemen <video> native. Itu bukan
 * "embed" di mata YouTube, melainkan pemutaran stream biasa, sehingga
 * lolos dari pembatasan embed.
 *
 * URL hasilnya terkunci ke IP mesin ini dan kedaluwarsa ~6 jam —
 * cukup untuk diputar langsung di Console (daemon & Console satu mesin).
 */

let cachedBin = null;
let cachedDeno = null;   // "" = sudah dicari, tak ada.

/** Pindai folder paket WinGet untuk sebuah exe. */
function scanWinget(exeName) {
    try {
        const pkgRoot = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
        for (const dir of fs.readdirSync(pkgRoot)) {
            const exe = path.join(pkgRoot, dir, exeName);
            if (fs.existsSync(exe)) return exe;
        }
    }
    catch { /* folder tak ada */ }
    return null;
}

/** Temukan biner yt-dlp: PATH dulu, lalu lokasi pemasangan WinGet. */
function resolveBin() {

    if (cachedBin) return cachedBin;

    const links = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "yt-dlp.exe");

    cachedBin = [links, scanWinget("yt-dlp.exe")].find(c => c && fs.existsSync(c)) ?? "yt-dlp";
    return cachedBin;

}

/**
 * Runtime JavaScript (deno) untuk yt-dlp. Tanpa ini yt-dlp tak dapat
 * memecahkan parameter `n` YouTube dan turun ke client fallback yang
 * streamnya bisa TER-THROTTLE / tak stabil (video macet-macet). Dengan
 * deno, yt-dlp memakai web client penuh → stream lancar. Dikembalikan
 * path deno bila ada, atau null.
 */
function resolveDeno() {
    if (cachedDeno !== null) return cachedDeno || null;
    const links = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "deno.exe");
    cachedDeno = [links, scanWinget("deno.exe")].find(c => c && fs.existsSync(c)) ?? "";
    return cachedDeno || null;
}

/**
 * Kembalikan URL stream progresif untuk sebuah video YouTube.
 * @param {string} videoId  id 11-karakter, atau URL watch lengkap.
 * @returns {Promise<string|null>} URL langsung, atau null bila gagal.
 */
async function resolveStream(videoId) {

    const id = String(videoId ?? "").trim();
    if (!id) return null;

    const url = /^https?:\/\//.test(id)
        ? id
        : `https://www.youtube.com/watch?v=${id}`;

    const deno = resolveDeno();

    try {
        const { stdout } = await pexec(
            resolveBin(),
            [
                // Pakai deno bila ada → pecahkan param `n`, stream penuh
                // (tanpa ini video macet karena client fallback throttled).
                ...(deno ? ["--js-runtimes", `deno:${deno}`] : []),
                // itag 18 (mp4 360p, audio+video satu berkas) → paling
                // kompatibel dengan <video>. Fallback: mp4 progresif apa
                // pun yang punya audio DAN video (bukan DASH terpisah).
                "-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]",
                "-g",
                "--no-warnings",
                "--no-playlist",
                url
            ],
            { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }
        );

        const link = String(stdout).trim().split("\n")[0].trim();
        return link.startsWith("http") ? link : null;
    }
    catch {
        return null;   // yt-dlp tak ada / video tak bisa diekstrak
    }

}

/**
 * UNDUH media ke berkas lokal (sekali), lalu kembalikan path-nya.
 *
 * Kenapa bukan sekadar URL langsung: memutar URL googlevideo dari
 * <video> membuat browser menembak banyak permintaan range ke server
 * YouTube → "429 Too Many Requests" → video macet/putus. Dengan
 * mengunduh SEKALI lewat yt-dlp (satu klien resmi, di-retry) lalu
 * menyajikan berkas lokal, pemutaran tak lagi menyentuh googlevideo →
 * nol 429, mulus. Hasilnya di-cache per videoId (putar ulang instan).
 *
 * @returns {Promise<string|null>} path berkas mp4, atau null bila gagal.
 */
async function downloadMedia(videoId) {

    const id = String(videoId ?? "").replace(/[^\w-]/g, "");
    if (!id) return null;

    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ada */ }

    const out = path.join(CACHE_DIR, `${id}.mp4`);

    // Cache: berkas sudah ada & berisi → pakai ulang (sentuh mtime agar
    // lagu yang sering diputar tak dianggap "terlama" saat prune).
    try {
        if (fs.statSync(out).size > 0) {
            try { fs.utimesSync(out, new Date(), new Date()); } catch { /* abaikan */ }
            return out;
        }
    }
    catch { /* belum ada */ }

    const deno = resolveDeno();
    const url = `https://www.youtube.com/watch?v=${id}`;

    try {
        await pexec(
            resolveBin(),
            [
                ...(deno ? ["--js-runtimes", `deno:${deno}`] : []),
                // Klien mweb: itag 18 progresifnya BISA diunduh. Klien
                // default (android_vr) memberi URL yang "403 Forbidden"
                // saat diunduh — itu sebab video "unavailable" (unduhan
                // gagal -> jatuh ke embed). web/tv butuh PO-token/DRM.
                "--extractor-args", "youtube:player_client=mweb",
                "-f", "18/best[ext=mp4][acodec!=none][vcodec!=none]",
                "-o", out,
                // 429 saat unduh (YouTube membatasi laju) diserap dengan
                // retry+jeda, bukan langsung gagal. Inilah yang memunculkan
                // pesan "429" walau video akhirnya jadi.
                "--retries", "10",
                "--fragment-retries", "10",
                "--retry-sleep", "2",
                "--no-warnings",
                "--no-playlist",
                "--no-part",
                url
            ],
            { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 }
        );

        const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
        if (ok) pruneCache();   // jaga total cache ≤ 500 MB
        return ok ? out : null;
    }
    catch {
        // yt-dlp keluar non-nol (mis. 429 tak teratasi) TAPI berkas bisa
        // saja sudah lengkap dari percobaan sebelumnya — pakai bila ada.
        try {
            if (fs.statSync(out).size > 0) { pruneCache(); return out; }
        }
        catch { /* memang tak ada */ }
        return null;
    }

}

module.exports = { resolveStream, downloadMedia, CACHE_DIR };
