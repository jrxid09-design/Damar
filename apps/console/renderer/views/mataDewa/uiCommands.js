/*
 * uiCommands.js — sisi renderer batas perintah UI Damar (MD-001).
 *
 * Menerima event `damar:ui-command` dari aliran SSE kanonik yang SUDAH ADA
 * (api.connectEvents → onEvent) dan menerapkannya lewat allowlist mirror
 * dari src/mataDewa/uiCommands.js. Tidak ada eval, tidak ada eksekusi
 * JavaScript arbitrer, tidak ada jalan pintas model→jendela.
 *
 * Perintah VISUAL-ONLY: navigasi mode di aplikasi Damar yang sama.
 * Perintah konsekuensial tidak pernah lewat sini (Action Fabric kanonik).
 */

const ALLOWED_COMMANDS = Object.freeze({
    "ui.mode.set": Object.freeze({
        /** value ∈ { "mata-dewa", "normal" } — sama dengan schema server. */
        validateArgs(args) {
            return args && (args.mode === "mata-dewa" || args.mode === "normal");
        },
    }),
});

let lastSeq = 0;

/**
 * Terapkan satu event perintah UI. Mengembalikan deskripsi hasil untuk tes.
 * @param {{ command:string, args?:object, seq?:number, visualOnly?:boolean }} event
 * @param {{ navigate: (id:string)=>void, onUnknown?: (reason:string)=>void }} surface
 */
export function applyUiCommandEvent(event, surface) {
    if (!event || typeof event !== "object" || event.visualOnly !== true) {
        return { ok: false, reason: "event bukan visual-only yang sah" };
    }
    // Anti-replay ringan: seq harus monoton naik per stream.
    if (Number.isFinite(event.seq)) {
        if (event.seq <= lastSeq) {
            return { ok: false, reason: "seq basi/duplikat diabaikan" };
        }
        lastSeq = event.seq;
    }
    const rule = ALLOWED_COMMANDS[event.command];
    if (!rule) {
        return { ok: false, reason: `perintah tidak diizinkan: ${String(event.command ?? "")}` };
    }
    if (!rule.validateArgs(event.args)) {
        return { ok: false, reason: "argumen ditolak allowlist" };
    }
    switch (event.command) {
        case "ui.mode.set": {
            // Navigasi di aplikasi Damar yang SAMA — bukan jendela kedua.
            surface.navigate(event.args.mode === "mata-dewa" ? "mata-dewa" : "core");
            return { ok: true, applied: event.command, mode: event.args.mode };
        }
        default:
            return { ok: false, reason: "perintah tanpa handler" };
    }
}

/** Reset anti-replay (dipakai koneksi ulang SSE / tes). */
export function resetUiCommandSequence() {
    lastSeq = 0;
}

/** Hook ke app.js: dipanggil dari onEvent untuk type "damar:ui-command". */
export function handleMataDewaUiCommandEvent(event) {
    return applyUiCommandEvent(event, {
        navigate: (id) => {
            // Import melingkar dihindari: app.js memanggil navigate-nya
            // sendiri lewat handler terdaftar. Default tidak ada.
            const fn = currentNavigator;
            if (typeof fn === "function") fn(id);
        },
    });
}

let currentNavigator = null;

/** Daftarkan fungsi navigasi milik app.js (satu kali). */
export function setUiCommandNavigator(fn) {
    currentNavigator = typeof fn === "function" ? fn : null;
}
