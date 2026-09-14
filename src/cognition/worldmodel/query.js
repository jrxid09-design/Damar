"use strict";

/**
 * W7-L2 WORLD MODEL — kontrak query (spec §9). Q-1: tidak ada bentuk yang
 * mengembalikan nilai telanjang — selalu amplop epistemik. Q-2: requireFresh
 * mengembalikan unknown, bukan nilai basi. Q-3: query tidak pernah memicu
 * probe. Q-4: query historis tidak pernah memfabrikasi state antara —
 * di implementasi minimal ini, `at` yang tidak didukung ditolak jujur
 * sebagai unknown, bukan ditebak.
 *
 * confidence DIHITUNG DI SINI SAJA (WM-A9) — rumus provisional persis
 * seperti disebut spec §6 sebagai provisional, bukan hasil final yang di-tuning.
 */

const { clamp01 } = require("../core/envelope");
const { isExpired, epistemicClassOf } = require("./beliefAlgebra");

function computeConfidence(belief, nowMs) {
    if (belief.tier === "DECLARED") return clamp01(0.9);
    const corroboration = Math.min(belief.supportedBy.length, 5) / 5; // 0..1
    const ageMs = Math.max(0, nowMs - belief.updatedAtMs);
    const ttlMs = belief.decayPolicy?.ttlMs ?? 30 * 60_000;
    const recency = clamp01(1 - ageMs / Math.max(ttlMs, 1));
    return clamp01(0.3 + 0.4 * corroboration + 0.3 * recency);
}

function subjectKeyOf(subject) {
    // Bug review independen (audit putaran-21, AUD21-ADV-1): subject
    // malformed (null/non-objek) meledakkan `.entityId` jadi TypeError
    // mentah -- dijaga jadi kunci yang tidak pernah cocok dengan belief
    // manapun (gagal aman ke NEVER_OBSERVED lewat beliefKey/query di
    // bawah, tidak pernah memfabrikasi atau menggabungkan subject lain).
    if (!subject || typeof subject !== "object") return "invalid:malformed-subject";
    // Bug review independen (audit putaran-25, AUD25-P2-1): `subject.entityId`
    // hanya dicek truthy, bukan tipenya -- entityId berupa objek hostile
    // dengan toString tereksekusi (mengeksekusi kode pemanggil di dalam
    // proses kognisi) tanpa pernah ditolak, mirip kelas AUD10-P2-3 yang
    // sudah ditutup untuk attention/metacog tapi tidak untuk lane ini.
    if (typeof subject.entityId === "string") return `entity:${subject.entityId}`;
    if (typeof subject.relationId === "string") return `relation:${subject.relationId}`;
    return "invalid:malformed-subject";
}

function beliefKey(subject, attribute) {
    // Bug review independen (audit putaran-25, AUD25-P2-1): `${attribute}`
    // mentah meledakkan TypeError untuk Symbol.
    const safeAttribute = typeof attribute === "string" ? attribute : typeof attribute;
    return `${subjectKeyOf(subject)}::${safeAttribute}`;
}

function query(beliefs, { subject, attribute, at = null, requireFresh = false, maxStalenessMs = null }, nowMs) {
    const belief = beliefs.get(beliefKey(subject, attribute));

    if (!belief) {
        return { unknown: true, reason: "NEVER_OBSERVED", lastKnown: null };
    }

    if (at) {
        // Q-4: implementasi minimal ini tidak menyimpan riwayat revisi penuh
        // per titik waktu; menjawab `at` akan memfabrikasi state antara,
        // yang dilarang. Menolak jujur, bukan menebak.
        return {
            unknown: true, reason: "HISTORICAL_QUERY_NOT_SUPPORTED",
            lastKnown: { value: belief.value, at: belief.observedAt }
        };
    }

    const stale = isExpired(belief, nowMs);
    if (requireFresh && stale) {
        return { unknown: true, reason: "STALE_SOURCE", lastKnown: { value: belief.value, at: belief.observedAt } };
    }
    // Bug review independen (audit putaran-28, AUD28-P2-4): perbandingan
    // relasi `>` memaksa ToNumber pada maxStalenessMs -- Symbol meledakkan
    // TypeError mentah, objek dengan valueOf hostile tereksekusi. Nilai
    // bukan angka valid diperlakukan sebagai "tidak ada batas staleness"
    // (perilaku default, bukan crash).
    const safeMaxStalenessMs = (typeof maxStalenessMs === "number" && Number.isFinite(maxStalenessMs)) ? maxStalenessMs : null;
    if (safeMaxStalenessMs !== null && (nowMs - belief.updatedAtMs) > safeMaxStalenessMs) {
        return { unknown: true, reason: "STALE_SOURCE", lastKnown: { value: belief.value, at: belief.observedAt } };
    }

    return {
        value: belief.value,
        epistemicClass: epistemicClassOf(belief, nowMs),
        confidence: computeConfidence(belief, nowMs),
        observedAt: belief.observedAt,
        contested: Boolean(belief.contradictionSetId),
        contradictionSetId: belief.contradictionSetId,
        supportedBy: belief.supportedBy,
        revision: belief.revision
    };
}

module.exports = { beliefKey, subjectKeyOf, computeConfidence, query };
