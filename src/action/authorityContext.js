"use strict";

/**
 * ACTION AUTHORITY GATE V1 — read-only authority context.
 *
 * A thin adapter that binds the existing Authority store's read primitives to
 * the CANONICAL read-only evaluator (`evaluateAuthorityReadOnly`), which is the
 * SINGLE source of truth shared with AuthorityRegistry.authorize(). This lane
 * does NOT re-implement authority policy — it delegates to the shared
 * evaluator.
 *
 * CRITICAL: read-only. Never appends events, never consumes budget, never
 * mints/revokes/suspends grants.
 */

const { evaluateAuthorityReadOnly, EVAL_REASONS } = require("../authority/evaluate");
const { captureClock } = require("./clock");

/**
 * Build a read-only authority evaluator over an existing Authority store.
 *
 * @param {object} store   Authority store (getCapability/getGeneration/countConsumption)
 * @param {object} [opts] { clock }
 * @returns {{ evaluate: (request) => Promise<{allowed, reasonCode, detail, snapshot}> }}
 */
function createReadOnlyAuthorityContext(store, { clock = { nowMs: () => Date.now() } } = {}) {
    if (!store || typeof store.getCapability !== "function") {
        throw new TypeError("authority context requires a store with getCapability");
    }
    const capturedClock = captureClock(clock);

    async function evaluate(request) {
        return evaluateAuthorityReadOnly(store, request, { nowMs: capturedClock.nowMs() });
    }

    return Object.freeze({ evaluate });
}

module.exports = { createReadOnlyAuthorityContext, DECISION_REASONS: EVAL_REASONS };
