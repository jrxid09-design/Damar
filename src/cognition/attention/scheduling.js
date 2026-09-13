"use strict";

/**
 * W7-L5 ATTENTION — komputasi effectivePriority (spec §5) dan pemilih
 * deficit-round-robin yang menghormati kuota kelas (§4) TANPA PERNAH
 * membiarkan kelas rendah kelaparan (AT-4/AT-5) — jaminan aging bersifat
 * struktural: target yang sudah menunggu >= MAX_WAIT_MS SELALU menang
 * atas urutan kuota biasa.
 */

const { CLASS_BASE, CLASS_QUOTA, PRIORITY_CLASSES, BOUNDS } = require("./bounds");

function agingBonus(waitingMs) {
    return Math.min(BOUNDS.AGING_BONUS_MAX, (waitingMs / BOUNDS.MAX_WAIT_MS) * BOUNDS.AGING_BONUS_MAX);
}

function decay(signalAgeMs) {
    return Math.min(BOUNDS.AGING_BONUS_MAX + BOUNDS.CORROBORATION_BONUS_MAX, signalAgeMs * BOUNDS.DECAY_PER_MS);
}

/** AT-5: hanya SUMBER berbeda dengan BUKTI berbeda yang dihitung — bukan pesan berulang. */
function corroborationBonus(distinctSourceEvidencePairs) {
    const n = Math.min(distinctSourceEvidencePairs, BOUNDS.MAX_DISTINCT_SOURCES_COUNTED);
    return (n / BOUNDS.MAX_DISTINCT_SOURCES_COUNTED) * BOUNDS.CORROBORATION_BONUS_MAX;
}

function computeEffectivePriority(target, { waitingMs, signalAgeMs, distinctSourceEvidencePairs }) {
    return CLASS_BASE[target.priorityClass]
        + agingBonus(waitingMs)
        - decay(signalAgeMs)
        + corroborationBonus(distinctSourceEvidencePairs);
}

/**
 * Deficit round-robin murni: state `credits` per kelas dipertahankan
 * pemanggil (bukan modul) supaya deterministik/dapat direplay (freeze
 * criterion #1). `pickOne` mengembalikan { target, credits, agingGuaranteed }.
 */
function initCredits() {
    return Object.fromEntries(PRIORITY_CLASSES.map(c => [c, 0]));
}

function pickOne(queuesByClass, credits, nowMs) {
    // Jaminan anti-starvation struktural: target manapun yang sudah
    // menunggu >= MAX_WAIT_MS menang tanpa syarat kuota (AT-4/AT-5).
    let oldestAged = null;
    for (const cls of PRIORITY_CLASSES) {
        for (const t of queuesByClass[cls] ?? []) {
            const waited = nowMs - t.admittedAt;
            if (waited >= BOUNDS.MAX_WAIT_MS && (!oldestAged || t.admittedAt < oldestAged.admittedAt)) {
                oldestAged = t;
            }
        }
    }
    if (oldestAged) return { target: oldestAged, credits, agingGuaranteed: true };

    // Selain itu: deficit round-robin biasa mengikuti kuota kelas.
    const nextCredits = { ...credits };
    for (const cls of PRIORITY_CLASSES) nextCredits[cls] += CLASS_QUOTA[cls];

    const eligible = PRIORITY_CLASSES.filter(cls => (queuesByClass[cls] ?? []).length > 0);
    if (eligible.length === 0) return { target: null, credits: nextCredits, agingGuaranteed: false };

    eligible.sort((a, b) => nextCredits[b] - nextCredits[a]);
    const chosenClass = eligible[0];
    nextCredits[chosenClass] -= 100; // satu "giliran" dikonsumsi, skala sama dengan total kuota (100)

    const queue = [...queuesByClass[chosenClass]].sort((a, b) => b.effectivePriority - a.effectivePriority);
    return { target: queue[0], credits: nextCredits, agingGuaranteed: false };
}

/**
 * §8: pemetaan attention -> prioritas governor. FUNGSI EKSPLISIT, TERBATAS,
 * TERAUDIT — tidak pernah salinan angka mentah (overlap O-17).
 */
const GOVERNOR_PRIORITY_MAP = Object.freeze({
    P0_SAFETY: "CRITICAL", P1_OWNER: "HIGH", P2_COMMITMENT: "HIGH",
    P3_GOAL: "NORMAL", P4_BACKGROUND: "LOW"
});

function mapToGovernorPriority(priorityClass, auditLog) {
    // Bug review independen (audit putaran-25, AUD25-ADV-2): indexing
    // objek langsung (`GOVERNOR_PRIORITY_MAP[priorityClass]`) memanggil
    // ToPropertyKey pada priorityClass -- objek hostile dengan
    // toString/Symbol.toPrimitive tereksekusi, dan nilai hasil coercion-nya
    // ikut tercatat ke governorMappingAudit (mencemari jejak audit dengan
    // string buatan pemanggil). priorityClass dinormalisasi ke primitif
    // dulu SEBELUM dipakai untuk indexing ATAU dicatat.
    const safePriorityClass = typeof priorityClass === "string" ? priorityClass : null;
    // Bug review independen (audit putaran-26, AUD26-P2-3): guard putaran-25
    // menormalisasi tipe tapi tidak memeriksa apakah kuncinya benar-benar
    // OWN PROPERTY -- "constructor"/"toString"/"__proto__"/"hasOwnProperty"
    // adalah string biasa yang lolos guard, lalu indexing mengembalikan
    // anggota Object.prototype yang terwarisi (fungsi/objek), bukan string
    // prioritas, dan nilai type-confused itu ikut tercatat ke audit trail.
    const mapped = (safePriorityClass && Object.prototype.hasOwnProperty.call(GOVERNOR_PRIORITY_MAP, safePriorityClass))
        ? GOVERNOR_PRIORITY_MAP[safePriorityClass] : "LOW";
    auditLog.push(Object.freeze({ priorityClass: safePriorityClass, mapped }));
    return mapped;
}

module.exports = {
    agingBonus, decay, corroborationBonus, computeEffectivePriority,
    initCredits, pickOne, GOVERNOR_PRIORITY_MAP, mapToGovernorPriority
};
