"use strict";

const { INTENTION_SCHEMA_VERSION } = require("./laws");

function validateIntention(opts) {
    if (!opts || !opts.intentionId) throw new Error("intentionId required (W10-L5/RT-W10-39)");
    if (!opts.subject) throw new Error("subject required — intentless execution refused (W10-L5/RT-W10-39)");
    if (!opts.intentText) throw new Error("intentText required — intentless execution refused (W10-L5/RT-W10-39)");
}

function makeIntention(opts = {}) {
    validateIntention(opts);
    return {
        schemaVersion: INTENTION_SCHEMA_VERSION,
        intentionId: opts.intentionId,
        subject: opts.subject,
        intentText: opts.intentText,
        context: opts.context || {},
        createdAt: Date.now(),
    };
}

module.exports = { makeIntention, validateIntention };
