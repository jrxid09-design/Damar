const crypto = require("node:crypto");

const AetherError = require("./AetherError");

/**
 * Deteksi kebuntuan V2 (§140) — SESSION-SCOPED + STICKY.
 *
 * V1 punya dua cacat yang ditemukan audit merah:
 *   H11 — Map global lintas sesi: pengguna A bisa menghakimi B, dan
 *         reset() tiap giliran menghapus jejak SEMUA orang.
 *   H12 — pelanggaran menghapus counter sebelum melempar: begitu
 *         terpicu, langsung boleh mencoba pola yang sama lagi.
 *
 * V2:
 *   - kunci = scope::tool:hash(args); scope = identitas eksekusi
 *     (sessionId/principal). Sesi lain tak saling menyentuh.
 *   - reset(scope) hanya membersihkan scope itu.
 *   - pelanggaran STICKY: pemicuan mencatat blockedUntil = now +
 *     COOLDOWN_MS untuk kunci itu; selama cooldown panggilan serupa
 *     ditolak tanpa menghapus apa pun. Cooldown berlalu → bersih.
 *   - deteksi siklus dipindah ke TurnController (berbasis urutan
 *     giliran; A→B→A→B dsb.) — modul ini tetap pemilik rem hammering
 *     identik lintas giliran dalam window.
 */

const WINDOW_MS = 60_000;
const SAME_CALL_LIMIT = 4;
const SAME_ERROR_LIMIT = 5;
const MAX_TRACKED = 400;          // naik: kini per-scope
const COOLDOWN_MS = Number(process.env.AETHER_LOOP_COOLDOWN_MS) || 30_000;

/** @type {Map<string, number[]>} scope::kunci → stempel waktu */
const calls = new Map();
const errors = new Map();
/** @type {Map<string, number>} kunci → blockedUntil */
const blocked = new Map();

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

function prune(map, key, now) {

    const list = (map.get(key) ?? []).filter(t => now - t < WINDOW_MS);

    if (list.length) map.set(key, list);
    else map.delete(key);

    if (map.size > MAX_TRACKED) {
        const oldest = [...map.entries()]
            .sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]))
            .slice(0, map.size - MAX_TRACKED);
        for (const [k] of oldest) map.delete(k);
    }

    return list;

}

function throwLoop(toolId, kind, count, recovery) {

    // STICKY (H12): catat blokir AKTIF; jangan hapus jejak pemicunya.
    blocked.set(`${kind}:${toolId}`, Date.now() + COOLDOWN_MS);

    throw new AetherError({
        code: kind === "call" ? "LOOP_DETECTED" : "REPEATED_FAILURE",
        message:
            `Tool "${toolId}" ${kind === "call"
                ? `dipanggil ${count}× dengan argumen yang sama`
                : `gagal ${count}× dengan penyebab yang sama`} dalam window. ` +
            `Ditahan ${Math.round(COOLDOWN_MS / 1000)} detik — ulangi pola sama tidak akan berhasil.`,
        severity: "info",
        retryable: false,
        cause: kind === "call" ? "Pengulangan identik terdeteksi" : "Kegagalan berulang terdeteksi",
        recovery: recovery ??
            "Ubah pendekatan: periksa asumsi, ganti argumen, pakai tool lain, atau tanyakan pengguna.",
        details: { tool: toolId, repeats: count }
    });

}

/**
 * Dipanggil SEBELUM eksekusi.
 * @param {string} toolId
 * @param {object} args
 * @param {string} [scope] identitas sesi/principal; default "global"
 *                         hanya untuk pemanggil non-interaktif.
 */
function assertNotLooping(toolId, args, scope = "global") {

    const now = Date.now();
    const key = `${scope}::${toolId}:${hash(args)}`;

    // Sticky block aktif? → tolak tanpa mencatat ulang.
    const until = blocked.get(`call:${key}`) ?? 0;

    if (now < until) {
        throw new AetherError({
            code: "LOOP_DETECTED",
            message:
                `Tool "${toolId}" masih ditahan ${Math.ceil((until - now) / 1000)}s ` +
                "oleh rem kebuntuan yang baru saja terpicu.",
            severity: "info",
            retryable: false,
            recovery: "Ganti pendekatan atau tunggu masa tenggang berlalu."
        });
    }

    const recent = prune(calls, key, now);

    if (recent.length >= SAME_CALL_LIMIT) {
        throwLoop(key, "call", recent.length);
    }

    calls.set(key, [...recent, now]);

}

/**
 * Dipanggil SESUDAH eksekusi gagal. Melempar bila error identik
 * menumpuk dalam window — DAN hasilnya sticky.
 */
function recordFailure(toolId, error, scope = "global") {

    const now = Date.now();
    const code = error?.code ?? error?.message?.slice(0, 60) ?? "unknown";
    const key = `${scope}::${toolId}:${hash(code)}`;

    const until = blocked.get(`error:${key}`) ?? 0;

    if (now < until) {
        return;   // sudah ditahan; jangan tumpuk error kedua
    }

    const recent = prune(errors, key, now);

    if (recent.length >= SAME_ERROR_LIMIT) {
        throwLoop(key, "error", recent.length,
            "Diagnosis akar masalah dulu, ganti tool, atau laporkan ke pengguna.");
    }

    errors.set(key, [...recent, now]);

}

/**
 * Kosongkan jejak SATU scope saja (H11).
 *
 * Scope wajib eksplisit: reset() tanpa scope TIDAK membersihkan apa pun
 * (dulu default-nya global reset — bug H4 yang bisa menghapus rem
 * kebuntuan sesi lain secara tidak sengaja). Pembersihan global yang
 * memang disengaja harus lewat resetAll().
 */
function reset(scope) {

    if (typeof scope !== "string" || !scope.trim()) {
        throw new AetherError({
            code: "INVALID_LOOPGUARD_SCOPE",
            message:
                "loopGuard.reset() butuh scope eksplisit (sessionId/principalId). " +
                "Gunakan resetAll() bila memang ingin membersihkan semua sesi.",
            severity: "warn",
            retryable: false,
            recovery: "Sertakan scope, atau panggil resetAll() secara sadar."
        });
    }

    const prefix = `${scope}::`;

    for (const map of [calls, errors]) {
        for (const key of [...map.keys()]) {
            if (key.startsWith(prefix)) map.delete(key);
        }
    }

    // Kunci blocked berbentuk `${kind}:${scope}::tool:hash` — cocokkan
    // TERSTRUKTUR per kind, bukan includes(prefix) yang bisa salah
    // hapus bila scope muncul di tengah kunci milik scope lain.
    for (const key of [...blocked.keys()]) {
        if (key.startsWith(`call:${prefix}`) || key.startsWith(`error:${prefix}`)) {
            blocked.delete(key);
        }
    }

}

/** Pembersihan global yang EKSPLISIT — hanya untuk shutdown/test/admin. */
function resetAll() {
    calls.clear();
    errors.clear();
    blocked.clear();
}

function state() {
    return {
        trackedCalls: calls.size,
        trackedErrors: errors.size,
        activeBlocks: blocked.size,
        windowSeconds: WINDOW_MS / 1000,
        sameCallLimit: SAME_CALL_LIMIT,
        sameErrorLimit: SAME_ERROR_LIMIT,
        cooldownMs: COOLDOWN_MS
    };
}

module.exports = { assertNotLooping, recordFailure, reset, resetAll, state };

