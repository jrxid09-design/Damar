"use strict";

const { BOUNDS } = require("./bounds");
const { LAWS } = require("./laws");

const RESERVED_MONEY_NAMES = new Set(["money", "usd", "eur", "currency", "fiat", "crypto", "coin"]);

function makeKinds(store) {
    async function registerKind(name, opts = {}) {
        if (typeof name !== "string" || !name) throw new Error("Kind name required");
        if (Buffer.byteLength(name) > BOUNDS.MAX_KIND_NAME_BYTES) throw new Error("Kind name too long");
        if (LAWS.MONEY_KIND_UNAVAILABLE && RESERVED_MONEY_NAMES.has(name.toLowerCase())) {
            throw new Error(
                `Kind '${name}' is unavailable: money kind requires canonical financial governance (W9-L5/BLK-04)`
            );
        }
        const kinds = await store.getIndex("kinds");
        if (kinds.length >= BOUNDS.MAX_RESOURCE_KINDS) throw new Error("MAX_RESOURCE_KINDS reached");
        const existing = await store.getKv(`kind:${name}`);
        if (existing) throw new Error(`Kind '${name}' already registered`);
        const record = { name, unit: opts.unit || "units", limit: opts.limit ?? Infinity, registeredAt: Date.now() };
        await store.putKv(`kind:${name}`, record);
        await store.addToIndex("kinds", name);
        return record;
    }

    async function getKind(name) {
        return store.getKv(`kind:${name}`);
    }

    async function listKinds() {
        const names = await store.getIndex("kinds");
        const records = await Promise.all(names.map(n => store.getKv(`kind:${n}`)));
        return records.filter(Boolean);
    }

    return { registerKind, getKind, listKinds };
}

module.exports = { makeKinds };
