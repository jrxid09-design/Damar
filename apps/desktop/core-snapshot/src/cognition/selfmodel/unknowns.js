"use strict";

/**
 * W7-L1 SELF-MODEL — daftar Unknown (spec §7): ketidaktahuan-diri sebagai
 * data pertama-kelas, bukan kekosongan yang disembunyikan (SM-A10).
 */

const REASONS = Object.freeze([
    "NO_SOURCE", "STALE_SOURCE", "CONTESTED", "NEVER_OBSERVED", "OUT_OF_SCOPE"
]);
const PROBE_COST = Object.freeze(["NONE", "CHEAP", "EXPENSIVE", "OWNER"]);

function makeUnknown({ subject, reason, since, lastKnown = null, probeCost = "NONE" }) {
    if (!REASONS.includes(reason)) reason = "OUT_OF_SCOPE";
    if (!PROBE_COST.includes(probeCost)) probeCost = "NONE";
    return Object.freeze({
        subject: String(subject).slice(0, 200),
        reason,
        since,
        lastKnown: lastKnown ? Object.freeze({ ...lastKnown }) : null,
        probeCost
    });
}

/**
 * Tambah Unknown ke daftar terbatas. Overflow membuang entri BERNILAI
 * TERENDAH (yang paling lama "since"), bukan yang termuda, dan mengembalikan
 * `truncated: true` — supaya ketidaktahuan yang paling baru tidak pernah
 * disembunyikan demi ketidaktahuan yang lebih basi.
 */
function addUnknown(list, entry, maxUnknowns) {
    const next = [...list, entry];
    if (next.length <= maxUnknowns) {
        return { list: next, truncated: false };
    }
    const sorted = [...next].sort((a, b) => String(a.since).localeCompare(String(b.since)));
    return { list: sorted.slice(sorted.length - maxUnknowns), truncated: true };
}

module.exports = { REASONS, PROBE_COST, makeUnknown, addUnknown };
