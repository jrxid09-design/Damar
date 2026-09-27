"use strict";

function pairKey(questionRef, probeId) {
    return `${questionRef.length}:${questionRef}${probeId}`;
}

function belowBound(current, maximum) {
    return Number.isSafeInteger(current) && Number.isSafeInteger(maximum) && current >= 0 && current < maximum;
}

module.exports = { pairKey, belowBound };
