"use strict";

const { BOUNDS, SHORTFALL_SCHEMA_VERSION } = require("./bounds");

function makeShortfall(store) {
    async function record(kind, opts = {}) {
        const count = await store.getKv("shortfall:count") || 0;
        if (count >= BOUNDS.MAX_SHORTFALL_RECORDS) throw new Error("MAX_SHORTFALL_RECORDS reached");
        const id = `${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const entry = {
            schemaVersion: SHORTFALL_SCHEMA_VERSION,
            id,
            kind,
            available: opts.available ?? null,
            needed: opts.needed ?? null,
            planId: opts.planId || null,
            recordedAt: Date.now(),
        };
        await store.putKv(`shortfall:${id}`, entry);
        await store.addToIndex(`shortfall:kind:${kind}`, id);
        await store.putKv("shortfall:count", count + 1);
        return entry;
    }

    async function list(kind) {
        const ids = await store.getIndex(`shortfall:kind:${kind}`);
        const records = await Promise.all(ids.map(id => store.getKv(`shortfall:${id}`)));
        return records.filter(Boolean);
    }

    return { record, list };
}

module.exports = { makeShortfall };
