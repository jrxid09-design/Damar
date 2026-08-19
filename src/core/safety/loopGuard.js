const crypto = require("node:crypto");

const AetherError = require("./AetherError");

/**
 * Deteksi kebuntuan (§140, Konstitusi Pasal 10.6).
 *
 * Model yang kehilangan arah punya kebiasaan khas: memanggil tool
 * yang sama dengan argumen yang sama berulang kali, atau menabrak
 * error yang sama terus-menerus sambil berharap hasil berbeda.
 * Tanpa rem, satu percakapan bisa membakar ribuan token dan
 * memanggil sistem luar puluhan kali tanpa kemajuan apa pun.
 *
 * Modul ini menghentikannya dan memaksa perubahan strategi.
 *
 * Ambangnya sengaja LONGGAR. Pengulangan yang sah itu nyata:
 * memantau status, membaca berkas yang sama di dua langkah,
 * mencoba ulang setelah jeda. Menuduh terlalu cepat lebih merusak
 * daripada membiarkan beberapa pengulangan lewat.
 */

const WINDOW_MS = 60_000;          // rentang pengamatan
const SAME_CALL_LIMIT = 4;         // panggilan identik dalam rentang
const SAME_ERROR_LIMIT = 5;        // error identik dalam rentang
const MAX_TRACKED = 200;           // batas memori jejak

/** @type {Map<string, number[]>} kunci → daftar stempel waktu */
const calls = new Map();
const errors = new Map();

function hash(value) {
    try {
        return crypto
            .createHash("sha1")
            .update(JSON.stringify(value ?? null))
            .digest("hex")
            .slice(0, 12);
    }
    catch {
        return "unhashable";
    }
}

/** Buang stempel di luar rentang; kembalikan yang tersisa. */
function prune(map, key, now) {

    const list = (map.get(key) ?? []).filter(t => now - t < WINDOW_MS);

    if (list.length) map.set(key, list);
    else map.delete(key);

    // Jangan biarkan jejak tumbuh tanpa batas pada sesi panjang.
    if (map.size > MAX_TRACKED) {
        const oldest = [...map.entries()]
            .sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]))
            .slice(0, map.size - MAX_TRACKED);
        for (const [k] of oldest) map.delete(k);
    }

    return list;

}

/**
 * Dipanggil SEBELUM eksekusi. Melempar bila panggilan identik
 * sudah terlalu sering diulang dalam rentang waktu.
 */
function assertNotLooping(toolId, args) {

    const now = Date.now();
    const key = `${toolId}:${hash(args)}`;

    const recent = prune(calls, key, now);

    if (recent.length >= SAME_CALL_LIMIT) {

        // Bersihkan supaya setelah strategi berubah, tool ini
        // tidak langsung terblokir lagi oleh jejak lama.
        calls.delete(key);

        throw new AetherError({
            code: "LOOP_DETECTED",
            message:
                `Tool "${toolId}" dipanggil ${recent.length}× dengan argumen yang sama ` +
                `dalam ${Math.round(WINDOW_MS / 1000)} detik. Dihentikan — ` +
                `mengulang hal yang sama tidak akan memberi hasil berbeda.`,
            severity: "info",
            retryable: false,
            cause: "Pengulangan identik terdeteksi",
            recovery:
                "Ubah pendekatan: periksa asumsi, ganti argumen, pakai tool lain, " +
                "atau tanyakan kembali kepada pengguna.",
            details: { tool: toolId, repeats: recent.length, windowSeconds: WINDOW_MS / 1000 }
        });

    }

    calls.set(key, [...recent, now]);

}

/**
 * Dipanggil SESUDAH eksekusi gagal. Melempar bila error yang sama
 * berulang — menandakan penyebabnya tidak tersentuh oleh percobaan
 * ulang.
 */
function recordFailure(toolId, error) {

    const now = Date.now();
    const code = error?.code ?? error?.message?.slice(0, 60) ?? "unknown";
    const key = `${toolId}:${code}`;

    const recent = prune(errors, key, now);

    if (recent.length >= SAME_ERROR_LIMIT) {

        errors.delete(key);

        throw new AetherError({
            code: "REPEATED_FAILURE",
            message:
                `Tool "${toolId}" gagal ${recent.length}× dengan penyebab yang sama ` +
                `(${code}). Dihentikan — percobaan ulang tidak menyentuh akar masalahnya.`,
            severity: "error",
            retryable: false,
            cause: String(code),
            recovery: "Diagnosis akar masalah dulu, atau laporkan ke pengguna.",
            details: { tool: toolId, failures: recent.length, code: String(code) }
        });

    }

    errors.set(key, [...recent, now]);

}

/**
 * Kosongkan jejak. Dipanggil saat giliran pengguna baru dimulai —
 * permintaan baru berhak atas kesempatan yang bersih.
 */
function reset() {
    calls.clear();
    errors.clear();
}

/** Untuk diagnostik & UI. */
function state() {
    return {
        trackedCalls: calls.size,
        trackedErrors: errors.size,
        windowSeconds: WINDOW_MS / 1000,
        sameCallLimit: SAME_CALL_LIMIT,
        sameErrorLimit: SAME_ERROR_LIMIT
    };
}

module.exports = { assertNotLooping, recordFailure, reset, state };
