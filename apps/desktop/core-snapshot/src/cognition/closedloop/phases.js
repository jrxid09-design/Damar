"use strict";

/**
 * The canonical loop order is FIXED (frozen contract, W8_EMBODIMENT_CONTRACT.md
 * §5): OBSERVE -> INTERPRET -> PREDICT -> PLAN -> AUTHORIZE -> ACT ->
 * OBSERVE EFFECT -> VERIFY -> UPDATE. A missing stage SHORTENS the certified
 * loop (never silently skips AUTHORIZE or VERIFY).
 */
const PHASE = Object.freeze({
    OBSERVE: "OBSERVE",
    INTERPRET: "INTERPRET",
    PREDICT: "PREDICT",
    PLAN: "PLAN",
    AUTHORIZE: "AUTHORIZE",
    ACT: "ACT",
    OBSERVE_EFFECT: "OBSERVE_EFFECT",
    VERIFY: "VERIFY",
    UPDATE: "UPDATE"
});

const LOOP_ORDER = Object.freeze([
    PHASE.OBSERVE,
    PHASE.INTERPRET,
    PHASE.PREDICT,
    PHASE.PLAN,
    PHASE.AUTHORIZE,
    PHASE.ACT,
    PHASE.OBSERVE_EFFECT,
    PHASE.VERIFY,
    PHASE.UPDATE
]);

module.exports = { PHASE, LOOP_ORDER };
