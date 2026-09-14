"use strict";

/**
 * W7-L5 ATTENTION — kebijakan penetapan kelas (spec §4, AT-1/AT-2).
 * SATU-SATUNYA tempat priorityClass ditentukan. `SalienceSignal` TIDAK
 * PERNAH punya field kelas sendiri (lihat records.js) — mustahil disuap.
 */

const P0_ORIGINS = new Set(["SAFETY_MONITOR", "OWNER_STOP", "SELF_MAINTENANCE_HALT"]);

/** AT-2/AT-3: origin string SENDIRI tidak cukup — sourceKind yang boleh
 * mengklaimnya juga di-allowlist, supaya AGENT/SENSOR tidak bisa memalsukan
 * evidenceRef.originKind untuk melompat ke P0_SAFETY. */
const P0_ORIGIN_TRUSTED_SOURCE_KINDS = Object.freeze({
    SAFETY_MONITOR: new Set(["SYSTEM"]),
    SELF_MAINTENANCE_HALT: new Set(["SYSTEM", "SELF"]),
    OWNER_STOP: new Set(["OWNER"])
});

function assignPriorityClass(signal) {
    // Bug review independen (audit putaran-40, AUD40-P2-1): evidenceRef
    // berbentuk FUNCTION sengaja diterima sebagai data TIDAK AKTIF (lihat
    // deepFreeze/makeSignal, AT-repair-18/29/35) -- tapi di sini
    // `signal.evidenceRef?.originKind`/`.ownerTrustVerified` membacanya
    // lewat [[Get]] biasa TANPA memandang tipe, jadi getter/trap Proxy
    // milik function evidenceRef tetap tereksekusi (dan Proxy yang sudah
    // di-revoke melempar TypeError mentah). Function bukan objek
    // PEMBAWA-DATA yang sah untuk originKind -- hanya objek non-function
    // yang boleh dibaca.
    const ev = (signal.evidenceRef && typeof signal.evidenceRef === "object") ? signal.evidenceRef : null;
    const origin = ev?.originKind;

    if (origin && P0_ORIGINS.has(origin) && P0_ORIGIN_TRUSTED_SOURCE_KINDS[origin].has(signal.sourceKind)) {
        if (origin === "OWNER_STOP" && !ev?.ownerTrustVerified) {
            // Klaim owner-stop tanpa verifikasi saluran trust ditolak turun ke P1.
            return "P1_OWNER";
        }
        return "P0_SAFETY";
    }

    // AT-9: sinyal AGENT tidak pernah membawa kelasnya sendiri — selalu dasar.
    if (signal.sourceKind === "AGENT") return "P4_BACKGROUND";

    if (signal.sourceKind === "OWNER") return "P1_OWNER";
    if (origin === "COMMITMENT_DUE") return "P2_COMMITMENT";
    if (signal.sourceKind === "GOAL" || signal.sourceKind === "MISSION") return "P3_GOAL";

    return "P4_BACKGROUND";
}

module.exports = { P0_ORIGINS, assignPriorityClass };
