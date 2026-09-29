"use strict";

const { VERIFICATION_STATES } = require("./laws");

function computeVerificationState(episode, resolveEvidence) {
    if (!resolveEvidence || !episode.evidence || episode.evidence.length === 0) {
        return VERIFICATION_STATES.UNSUPPORTED;
    }
    const results = episode.evidence.map(ref => resolveEvidence(ref));
    const resolved = results.filter(Boolean).length;
    if (resolved === 0) return VERIFICATION_STATES.UNSUPPORTED;
    if (resolved === episode.evidence.length) return VERIFICATION_STATES.SUPPORTED;
    return VERIFICATION_STATES.PARTIALLY_SUPPORTED;
}

function canCiteAsReason(episode) {
    // RT-W10-27: UNSUPPORTED and DISPUTED episodes may not be cited as reasons to act
    const blocked = new Set([VERIFICATION_STATES.UNSUPPORTED, VERIFICATION_STATES.DISPUTED]);
    return !blocked.has(episode.verificationState);
}

module.exports = { computeVerificationState, canCiteAsReason };
