const path = require("node:path");

const JsonStore = require("../config/JsonStore");
const DamarError = require("./DamarError");

/**
 * Kill switch global (§37, Konstitusi Pasal 2.1).
 *
 * Sebelum ini Damar tidak punya cara dihentikan. Sekali sebuah
 * rangkaian tool berjalan, ia berjalan sampai selesai — tidak ada
 * rem. Untuk sistem yang tujuannya bertindak otonom, itu lubang
 * keamanan paling dasar.
 *
 * STOP mengalahkan segalanya. Ia menghentikan eksekusi tool,
 * tugas otonom, dan pekerjaan latar, sambil membiarkan pembacaan
 * keadaan tetap jalan supaya pemilik masih bisa melihat apa yang
 * terjadi dan memulihkannya.
 *
 * SENGAJA DIPERTAHANKAN LINTAS RESTART: kalau pemilik menekan STOP
 * lalu daemon crash dan hidup lagi, otonomi TIDAK boleh menyala
 * diam-diam. Melepasnya harus tindakan sadar.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "..", "configs", "safety.json"),
    { stopped: false, reason: null, actor: null, since: null }
);

/** Operasi yang tetap diizinkan saat berhenti: hanya baca keadaan. */
const READ_ONLY_ALLOWLIST = new Set([
    "system_health",
    "damarSkills.system_health",
    "damarSkills.agents_status",
    "damarSkills.wa_status"
]);

let listeners = [];

function state() {
    return store.read();
}

function isEngaged() {
    return state().stopped === true;
}

/**
 * Tarik rem. Idempoten — menekan STOP dua kali bukan error.
 *
 * @param {object} opts
 * @param {string} [opts.reason] alasan, untuk audit
 * @param {string} [opts.actor]  siapa yang menghentikan
 */
function engage({ reason = "permintaan pengguna", actor = "user" } = {}) {

    const already = isEngaged();

    if (!already) {
        store.write({
            stopped: true,
            reason,
            actor,
            since: new Date().toISOString()
        });
    }

    notify("engaged", { reason, actor, alreadyEngaged: already });

    return { ...state(), alreadyEngaged: already };

}

/**
 * Lepas rem. Sengaja tidak otomatis: hanya pemilik yang boleh
 * mengembalikan Damar ke keadaan dapat bertindak.
 */
function release({ actor = "user" } = {}) {

    const wasEngaged = isEngaged();

    store.write({ stopped: false, reason: null, actor: null, since: null });

    notify("released", { actor, wasEngaged });

    return { ...state(), wasEngaged };

}

/**
 * Penjaga yang dipanggil sebelum tiap tindakan berefek samping.
 * Melempar DamarError bila rem tertarik.
 *
 * @param {string} [operation] nama operasi, untuk pesan & allowlist
 */
function assertRunning(operation = "operasi") {

    if (!isEngaged()) {
        return;
    }

    if (READ_ONLY_ALLOWLIST.has(operation)) {
        return;
    }

    const s = state();

    throw new DamarError({
        code: "SAFETY_STOP_ENGAGED",
        message:
            `Damar dihentikan — "${operation}" tidak dijalankan. ` +
            `Alasan: ${s.reason ?? "tidak disebutkan"}.`,
        severity: "info",
        retryable: false,
        cause: `Kill switch ditarik oleh ${s.actor ?? "?"} pada ${s.since ?? "?"}`,
        recovery: "Lepaskan lewat POST /api/v1/console/safety/release atau tombol di Console.",
        details: { operation, since: s.since }
    });

}

/** Daftarkan pengamat perubahan (dipakai telemetri & UI). */
function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return () => { listeners = listeners.filter(f => f !== fn); };
}

function notify(event, payload) {
    for (const fn of listeners) {
        try { fn(event, { ...payload, state: state() }); }
        catch { /* pengamat tidak boleh menjatuhkan kill switch */ }
    }
}

module.exports = {
    isEngaged,
    engage,
    release,
    assertRunning,
    onChange,
    state,
    READ_ONLY_ALLOWLIST
};
