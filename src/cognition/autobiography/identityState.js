"use strict";

const { VERIFICATION_STATES } = require("./laws");

function computeIdentityState(episodes, damarIdentityId) {
    const supported = episodes.filter(e =>
        e.verificationState === VERIFICATION_STATES.SUPPORTED ||
        e.verificationState === VERIFICATION_STATES.PARTIALLY_SUPPORTED
    );
    const themes = [...new Set(supported.flatMap(e => e.title ? [e.title.split(" ")[0]] : []))];
    return {
        damarIdentityId,
        summaryWindows: [{
            episodeCount: episodes.length,
            supportedCount: supported.length,
            themes: themes.slice(0, 10),
        }],
    };
}

module.exports = { computeIdentityState };
