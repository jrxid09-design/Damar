"use strict";

const { LAWS, BOUNDS, VERIFICATION_STATES } = require("./laws");
const { makeAutobiographyStore } = require("./store");
const { makeFormation, redactSecrets } = require("./formation");
const { makeCorrection } = require("./correction");
const { computeVerificationState, canCiteAsReason } = require("./verification");
const { computeIdentityState } = require("./identityState");
const { applyRetention, assertCompactionDoesNotRaise } = require("./retention");
const { makeEpisode } = require("./episode");

function makeAutobiographicalIdentity(acc) {
    const store = makeAutobiographyStore(acc);
    const formation = makeFormation(store);
    const correction = makeCorrection(store);
    return {
        store,
        formation,
        correction,
        computeVerificationState,
        canCiteAsReason,
        computeIdentityState,
        applyRetention,
        assertCompactionDoesNotRaise,
        makeEpisode,
        redactSecrets,
        LAWS,
        BOUNDS,
        VERIFICATION_STATES,
    };
}

module.exports = { makeAutobiographicalIdentity };
