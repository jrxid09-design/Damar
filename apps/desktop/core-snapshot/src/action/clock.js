"use strict";

/**
 * ACTION AUTHORITY GATE V1 — hardened clock capture.
 *
 * Mirrors Lane 1's clock pattern: read `nowMs` EXACTLY ONCE, capture its
 * FUNCTION IDENTITY (bound to the original owner), never retain the caller's
 * clock object, and never re-read `clock.nowMs`. Every returned timestamp is
 * validated: number, finite, nonnegative, safe integer.
 */

const { fail, REASONS } = require("./errors");

/**
 * Capture a validated nowMs function from a caller-owned clock, exactly once.
 * Returns a frozen { nowMs } whose function identity is fixed at capture time.
 */
function captureClock(clock) {
    const suppliedNowMs = (clock && typeof clock === "object") ? clock.nowMs : undefined;
    let capturedNowMs;
    if (typeof suppliedNowMs === "function") {
        capturedNowMs = suppliedNowMs.bind(clock);
    } else if (suppliedNowMs === undefined) {
        capturedNowMs = Date.now.bind(Date);
    } else {
        throw fail(REASONS.MALFORMED_INPUT, `clock.nowMs must be a function, got ${typeof suppliedNowMs}`);
    }
    return Object.freeze({
        nowMs() {
            const raw = capturedNowMs();
            if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw < 0) {
                throw fail(REASONS.MALFORMED_INPUT,
                    `clock returned an invalid timestamp (${typeof raw}); expected a nonnegative safe integer ms`);
            }
            return raw;
        }
    });
}

module.exports = { captureClock };
