"use strict";

const { PRIVILEGED_KINDS } = require("./laws");
const { WORKSPACE_SCHEMA_VERSION } = require("./bounds");

function validateItem(item) {
    if (!item || typeof item !== "object") throw new Error("item must be an object");
    if (!item.itemId) throw new Error("item requires itemId");
    if (!item.sourceRef) {
        throw new Error(`Workspace item requires a source reference — orphan projections refused (W10-L1/RT-W10-03)`);
    }
    if (item.kind && PRIVILEGED_KINDS.has(String(item.kind).toLowerCase())) {
        throw new Error(`Privileged object kind '${item.kind}' cannot be admitted to workspace — authority objects forbidden (W10-L1/RT-W10-02)`);
    }
    return true;
}

function makeItem(opts = {}) {
    validateItem(opts);
    return {
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        itemId: opts.itemId,
        sourceRef: opts.sourceRef,
        kind: opts.kind || "ref",
        tokens: typeof opts.tokens === "number" ? opts.tokens : 0,
        salience: typeof opts.salience === "number" ? opts.salience : 0,
        safety: opts.safety === true,
        pinned: false,
        freshness: opts.freshness || Date.now(),
        freshnessState: "CURRENT",
    };
}

module.exports = { validateItem, makeItem };
