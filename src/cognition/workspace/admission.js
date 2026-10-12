"use strict";

const { validateItem } = require("./item");

function makeAdmission(store, bounds, laws) {
    async function admit(rawItem) {
        // RT-W10-02 and RT-W10-03 handled by validateItem
        validateItem(rawItem);

        // RT-W10-09: refuse direct content storage; workspace holds refs only
        if (rawItem.content !== undefined) {
            throw new Error(`Workspace holds references only — direct content storage refused (W10-L1/RT-W10-09)`);
        }

        const items = await store.getItems();

        // RT-W10-08: refuse duplicate refs
        if (items.some(i => i.itemId === rawItem.itemId)) {
            throw new Error(`Duplicate item ref '${rawItem.itemId}' — dedup enforced (W10-L1/RT-W10-08)`);
        }

        // RT-W10-07: enforce pool cap
        if (items.length >= bounds.MAX_CONTEXT_POOL) {
            throw new Error(`Context pool at capacity (${bounds.MAX_CONTEXT_POOL}) — admission refused (W10-L1/RT-W10-07)`);
        }

        return true;
    }

    return { admit };
}

module.exports = { makeAdmission };
