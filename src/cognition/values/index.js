"use strict";

const { LAWS, BOUNDS, PREFERENCE_ORIGINS } = require("./laws");
const { makeValuesStore } = require("./store");
const { makePreferenceLearning } = require("./learning");
const { makePreference, validatePreference } = require("./preference");
const { makeValue } = require("./value");
const { rankOptions, resolveConflict } = require("./ranking");
const { applyCharacter } = require("./expression");
const { checkDrift } = require("./drift");

function makeGovernedCharacter(acc) {
    const store = makeValuesStore(acc);
    const learning = makePreferenceLearning(store);
    return {
        store,
        learning,
        makePreference,
        validatePreference,
        makeValue,
        rankOptions,
        resolveConflict,
        applyCharacter,
        checkDrift,
        LAWS,
        BOUNDS,
        PREFERENCE_ORIGINS,
    };
}

module.exports = { makeGovernedCharacter };
