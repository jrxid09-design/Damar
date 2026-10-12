"use strict";

/**
 * W7-L1 SELF-MODEL — derivasi CapabilitySelfAssessment (spec §5, aturan
 * S-1..S-5). Semua fungsi di sini murni: tidak menyentuh port, tidak
 * menyimpan state — hanya menerjemahkan bukti menjadi keyakinan diri.
 */

const { clamp01 } = require("../core/envelope");
const { ASSESSMENT_SCHEMA_VERSION } = require("./bounds");

const SELF_BELIEF = Object.freeze({
    USABLE: "USABLE",
    DEGRADED: "DEGRADED",
    UNUSABLE: "UNUSABLE",
    UNKNOWN: "UNKNOWN"
});

const EPISTEMIC_CLASS = Object.freeze({
    CACHED: "CACHED",
    DERIVED: "DERIVED",
    STALE: "STALE",
    UNKNOWN: "UNKNOWN"
});

const CONFIDENCE_BASIS = Object.freeze({
    OUTCOME_HISTORY: "OUTCOME_HISTORY",
    AVAILABILITY: "AVAILABILITY",
    NO_EVIDENCE: "NO_EVIDENCE"
});

function emptySuccessWindow(nowMs) {
    return Object.freeze({ attempts: 0, successes: 0, windowStartedAt: nowMs });
}

/** S-1: selfBelief berasal HANYA dari availability/successWindow/lastOutcome. */
function deriveSelfBelief({ availability, successWindow, lastOutcome }) {
    if (!availability || availability === "UNKNOWN") return SELF_BELIEF.UNKNOWN;
    if (availability === "UNAVAILABLE") return SELF_BELIEF.UNUSABLE;
    if (availability === "DEGRADED") return SELF_BELIEF.DEGRADED;

    // AVAILABLE, tapi riwayat hasil bisa menurunkannya.
    if (lastOutcome && lastOutcome.state === "FAILED") return SELF_BELIEF.DEGRADED;
    if (successWindow.attempts > 0 && successWindow.successes === 0) {
        return SELF_BELIEF.DEGRADED;
    }
    return SELF_BELIEF.USABLE;
}

/** S-11: basis confidence adalah enum dari bukti, bukan teks bebas. */
function deriveConfidence(successWindow) {
    if (!successWindow || successWindow.attempts === 0) {
        return Object.freeze({ value: 0, basis: CONFIDENCE_BASIS.NO_EVIDENCE });
    }
    const rate = successWindow.successes / successWindow.attempts;
    return Object.freeze({ value: clamp01(rate), basis: CONFIDENCE_BASIS.OUTCOME_HISTORY });
}

/**
 * Bangun satu CapabilitySelfAssessment.
 *
 * `cacheEntry` (bisa null): { availability, generation, observedAtMs } —
 * hasil ingestAvailability() terakhir untuk id ini, atau null jika belum
 * pernah diamati (S-3 baseline).
 */
function buildAssessment({
    capabilityId, descriptorRef, cacheEntry, successWindow, lastOutcome,
    nowMs, availabilityTtlMs
}) {

    const window = successWindow ?? emptySuccessWindow(nowMs);

    // S-3: TTL kedaluwarsa -> STALE, tidak pernah diam-diam disegarkan.
    const isStale = !cacheEntry ||
        (nowMs - cacheEntry.observedAtMs) > availabilityTtlMs;

    const availability = isStale ? null : cacheEntry.availability;
    const epistemicClass = !cacheEntry
        ? EPISTEMIC_CLASS.UNKNOWN
        : (isStale ? EPISTEMIC_CLASS.STALE : EPISTEMIC_CLASS.CACHED);

    // S-3: STALE tidak pernah dilaporkan sebagai USABLE.
    const selfBelief = isStale
        ? SELF_BELIEF.UNKNOWN
        : deriveSelfBelief({ availability, successWindow: window, lastOutcome });

    return Object.freeze({
        schemaVersion: ASSESSMENT_SCHEMA_VERSION,
        capabilityId,
        descriptorRef,
        availabilityRef: cacheEntry
            ? Object.freeze({ generation: cacheEntry.generation, observedAtMs: cacheEntry.observedAtMs })
            : null,
        availability: availability ?? "UNKNOWN",
        lastOutcome: lastOutcome
            ? Object.freeze({ ...lastOutcome }) : null,
        successWindow: Object.freeze({ ...window }),
        selfBelief,
        epistemicClass,
        confidence: deriveConfidence(window),
        observedAt: cacheEntry ? new Date(cacheEntry.observedAtMs).toISOString() : null,
        validUntil: cacheEntry
            ? new Date(cacheEntry.observedAtMs + availabilityTtlMs).toISOString() : null
    });
}

/** S-2: tanpa descriptor, satu-satunya nilai sah adalah UNKNOWN. */
function unknownAssessment(capabilityId) {
    return Object.freeze({
        schemaVersion: ASSESSMENT_SCHEMA_VERSION,
        capabilityId,
        descriptorRef: null,
        availabilityRef: null,
        availability: "UNKNOWN",
        lastOutcome: null,
        successWindow: emptySuccessWindow(0),
        selfBelief: SELF_BELIEF.UNKNOWN,
        epistemicClass: EPISTEMIC_CLASS.UNKNOWN,
        confidence: Object.freeze({ value: 0, basis: CONFIDENCE_BASIS.NO_EVIDENCE }),
        observedAt: null,
        validUntil: null
    });
}

module.exports = {
    SELF_BELIEF, EPISTEMIC_CLASS, CONFIDENCE_BASIS,
    emptySuccessWindow, deriveSelfBelief, deriveConfidence,
    buildAssessment, unknownAssessment
};
