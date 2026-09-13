"use strict";

/**
 * W7-L2 WORLD MODEL — aljabar revisi keyakinan (spec §6) + peluruhan
 * baca-waktu (spec §7). Satu-satunya tempat sebuah WorldBelief lahir atau
 * berevolusi. TIDAK PERNAH memutasi record lama di tempat (§3 "BELIEF
 * REVISION != OVERWRITE") — selalu mengembalikan revisi BARU.
 *
 * confidence TIDAK PERNAH menjadi field yang ditulis di sini — itu murni
 * hasil query.js pada saat baca (WM-A9).
 */

const { BOUNDS } = require("./bounds");

const TIER_RANK = Object.freeze({ T4: 1, T2: 2, T1: 3, DECLARED: 4 });

const DEFAULT_DECAY_POLICY = Object.freeze({ ttlMs: 30 * 60_000, decayKind: "STEP" });

function isExpired(belief, nowMs) {
    const policy = belief.decayPolicy ?? DEFAULT_DECAY_POLICY;
    if (policy.decayKind === "NONE") return false;
    return (nowMs - belief.updatedAtMs) > policy.ttlMs;
}

/** Kelas epistemik yang terlihat lewat query — dihitung, bukan disimpan tetap. */
function epistemicClassOf(belief, nowMs) {
    if (belief.tier !== "DECLARED" && isExpired(belief, nowMs)) return "STALE";
    return "OBSERVED";
}

function appendBounded(list, item, max) {
    const next = [...list, item];
    return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Terapkan satu record baru (`recordId`, `value`, `tier`, `observedAt`,
 * `observedAtMs`) ke belief subject/attribute yang ada (atau null bila
 * belum ada). Mengembalikan `{ case, belief, contradiction }` —
 * `contradiction` non-null hanya pada kasus CONTEST.
 */
function applyRevision({ existing, record, nowMs, decayPolicy = DEFAULT_DECAY_POLICY }) {

    if (!existing) {
        // Kelahiran pertama — setara REFRESH dari ketiadaan.
        return {
            case: "REFRESH",
            belief: Object.freeze({
                beliefId: `${record.subjectKey}::${record.attribute}`,
                subject: record.subject, attribute: record.attribute,
                value: record.value, revision: 1,
                supportedBy: Object.freeze([record.recordId]),
                contradictedBy: Object.freeze([]),
                contradictionSetId: null,
                tier: record.tier,
                decayPolicy,
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs
            }),
            contradiction: null
        };
    }

    const sameValue = JSON.stringify(existing.value) === JSON.stringify(record.value);
    const expired = isExpired(existing, nowMs);
    const newerOrEqualTier = TIER_RANK[record.tier] >= TIER_RANK[existing.tier];
    const newerInTime = record.observedAtMs === undefined || record.observedAtMs >= (existing.observedAtMs ?? 0);

    if (sameValue && !expired) {
        // REINFORCE
        return {
            case: "REINFORCE",
            belief: Object.freeze({
                ...existing,
                revision: existing.revision + 1,
                supportedBy: Object.freeze(appendBounded(existing.supportedBy, record.recordId,
                    BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF)),
                updatedAtMs: nowMs
            }),
            contradiction: null
        };
    }

    if (sameValue && expired) {
        // REFRESH
        return {
            case: "REFRESH",
            belief: Object.freeze({
                ...existing,
                revision: existing.revision + 1,
                supportedBy: Object.freeze(appendBounded(existing.supportedBy, record.recordId,
                    BOUNDS.MAX_OBSERVATIONS_RETAINED_PER_BELIEF)),
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs
            }),
            contradiction: null
        };
    }

    if (!sameValue && expired && newerOrEqualTier && newerInTime) {
        // SUPERSEDE — revisi lama dipertahankan dalam `supersedes`, bukan ditimpa diam-diam.
        return {
            case: "SUPERSEDE",
            belief: Object.freeze({
                beliefId: existing.beliefId, subject: existing.subject, attribute: existing.attribute,
                value: record.value, revision: existing.revision + 1,
                supportedBy: Object.freeze([record.recordId]),
                contradictedBy: Object.freeze([]),
                contradictionSetId: null,
                tier: record.tier, decayPolicy: existing.decayPolicy,
                updatedAtMs: nowMs, observedAt: record.observedAt,
                observedAtMs: record.observedAtMs ?? nowMs,
                supersedes: Object.freeze({ revision: existing.revision, value: existing.value })
            }),
            contradiction: null
        };
    }

    // CONTEST — nilai tidak berubah; kontradiksi dibuka.
    return {
        case: "CONTEST",
        belief: existing, // TIDAK berubah (§3, §6 CONTEST: "no value change")
        contradiction: {
            subject: existing.subject, attribute: existing.attribute,
            incumbentValue: existing.value, challengerValue: record.value,
            challengerRecordId: record.recordId, at: record.observedAt
        }
    };
}

module.exports = {
    TIER_RANK, DEFAULT_DECAY_POLICY, isExpired, epistemicClassOf, applyRevision
};
