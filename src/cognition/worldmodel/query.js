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
    return subject.entityId ? `entity:${subject.entityId}` : `relation:${subject.relationId}`;
}

function beliefKey(subject, attribute) {
    return `${subjectKeyOf(subject)}::${attribute}`;
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
    if (maxStalenessMs !== null && (nowMs - belief.updatedAtMs) > maxStalenessMs) {
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
