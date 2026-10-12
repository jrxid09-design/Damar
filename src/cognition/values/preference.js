"use strict";

const { PREF_SCHEMA_VERSION, BOUNDS, PREFERENCE_ORIGINS, PREFERENCE_KINDS } = require("./laws");

function validatePreference(opts) {
    if (!opts.preferenceId) throw new Error("preferenceId required");
    if (!opts.statement) throw new Error("statement required");
    // RT-W10-38: free-form instruction text rejected — must be concise inclination
    if (opts.statement.length > BOUNDS.MAX_STATEMENT_CHARS) {
        throw new Error(`Preference statement exceeds max length (${BOUNDS.MAX_STATEMENT_CHARS}) — instruction smuggling refused (W10-L4/RT-W10-38)`);
    }
    if (opts.statement.includes("\n")) {
        throw new Error(`Preference statement must be single-line — multi-line instruction rejected (W10-L4/RT-W10-38)`);
    }
    // RT-W10-35: agent-asserted preferences never become preferences
    if (opts.origin === "AGENT_STATED" || opts.origin === "AGENT_ASSERTED") {
        throw new Error(`Agent assertions never become preferences — tier rule enforced (W10-L4/RT-W10-35)`);
    }
    if (opts.subject && opts.subject.kind && !PREFERENCE_KINDS.includes(opts.subject.kind)) {
        throw new Error(`Invalid preference kind '${opts.subject.kind}'`);
    }
    return true;
}

function makePreference(opts = {}) {
    validatePreference(opts);
    return {
        schemaVersion: PREF_SCHEMA_VERSION,
        preferenceId: opts.preferenceId,
        subject: opts.subject || { kind: "STYLE", ref: null },
        statement: opts.statement,
        strength: typeof opts.strength === "number" ? Math.max(0, Math.min(1, opts.strength)) : 0.5,
        origin: opts.origin || PREFERENCE_ORIGINS.OWNER_STATED,
        evidence: opts.evidence || [],
        state: "ACTIVE",
        createdAt: Date.now(),
    };
}

module.exports = { validatePreference, makePreference };
