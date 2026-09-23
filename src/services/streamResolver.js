const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

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

    // INGRESS, NEVER AUTHORITY. yt-dlp runs only inside the Manager-owned
    // media capability, and only for a validated video id.
    const id11 = id.match(/[A-Za-z0-9_-]{11}/)?.[0];
    if (!id11) return null;
    const result = await require("../manager/bootstrap").getMediaCapabilityRuntime()
        .execute({ operation: "resolve", parameters: { videoId: id11 } });
    return result.outcome === "EXECUTED_VERIFIED" ? result.result.url : null;

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

    try {
        const result = await require("../manager/bootstrap").getMediaCapabilityRuntime()
            .execute({ operation: "download", parameters: { videoId: id } });
        if (result.outcome !== "EXECUTED_VERIFIED") return null;

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
