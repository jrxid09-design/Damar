"use strict";

const { VALUE_SCHEMA_VERSION } = require("./laws");

function validateValue(opts) {
    if (!opts.valueId) throw new Error("valueId required");
    if (!opts.statement) throw new Error("statement required");
    if (opts.declaredBy && opts.declaredBy !== "OWNER") {
        throw new Error("GovernedValue must be declared by OWNER (W10-L4)");
    }
    return true;
}

function makeValue(opts = {}) {
    validateValue(opts);
    return {
        schemaVersion: VALUE_SCHEMA_VERSION,
        valueId: opts.valueId,
        statement: opts.statement,
        declaredBy: "OWNER",
        appliesTo: opts.appliesTo || [],
        conflictsWith: opts.conflictsWith || [],
        precedenceRank: typeof opts.precedenceRank === "number" ? opts.precedenceRank : null,
        ratifiedAt: opts.ratifiedAt || Date.now(),
        version: opts.version || 1,
    };
}

module.exports = { validateValue, makeValue };
