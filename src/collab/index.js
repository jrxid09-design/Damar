"use strict";

const { makeCollabStore } = require("./store");
const { makeConsentManager } = require("./consent");
const { makeModeManager } = require("./mode");
const { makeStopHandler } = require("./stop");

function makeCollab(acc) {
    const store = makeCollabStore(acc);
    const consent = makeConsentManager(store);
    const mode = makeModeManager(store);
    const stop = makeStopHandler();
    return { consent, mode, stop };
}

module.exports = { makeCollab };
