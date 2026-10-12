"use strict";

/**
 * W7-L1 SELF-MODEL — ActiveLimitation (spec §4 "Limitations" domain).
 *
 * ATURAN KERAS: sebuah limitation boleh mencatat BAHWA suatu evaluasi
 * menolak sesuatu, DENGAN MERUJUK id evaluasi itu — tidak pernah grant,
 * scope, atau token yang akan mengizinkannya (§4, "No field stores a
 * grant, scope, token, or evaluation").
 */

const FORBIDDEN_KEYS = Object.freeze(["grant", "scope", "token", "evaluation", "authProof"]);

function makeLimitation(spec) {
    const { subject, reason, sourceRef, since, severity = "INFO" } = spec ?? {};
    for (const key of FORBIDDEN_KEYS) {
        if (Object.prototype.hasOwnProperty.call(spec ?? {}, key)) {
            throw new Error(`ACC selfmodel: limitation tidak boleh membawa field '${key}'`);
        }
    }
    return Object.freeze({
        subject: String(subject).slice(0, 200),
        reason: String(reason).slice(0, 200),
        sourceRef: sourceRef ? String(sourceRef).slice(0, 200) : null,
        since,
        severity: ["INFO", "WARN", "CRITICAL"].includes(severity) ? severity : "INFO"
    });
}

/** Overflow membuang entri TERLAMA (FIFO) — batas keras, bukan penilaian nilai. */
function addLimitation(list, entry, maxActiveLimitations) {
    const next = [...list, entry];
    if (next.length <= maxActiveLimitations) return { list: next, truncated: false };
    return { list: next.slice(next.length - maxActiveLimitations), truncated: true };
}

module.exports = { makeLimitation, addLimitation };
