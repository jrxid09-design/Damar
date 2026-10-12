"use strict";

const { makeItem } = require("./item");

function makeWorkspace(store, admission, eviction, assembly, bounds, laws) {
    async function admit(rawItem) {
        await admission.admit(rawItem);
        const items = await store.getItems();
        const item = makeItem(rawItem);
        items.push(item);
        await store.putItems(items);
        return item;
    }

    async function evictItem(itemId, reason) {
        return eviction.evict(itemId, reason);
    }

    async function setFocus(itemId) {
        // RT-W10-10: single focus invariant
        const items = await store.getItems();
        if (!items.some(i => i.itemId === itemId)) {
            throw new Error(`Cannot set focus to unknown item '${itemId}' (W10-L1/RT-W10-10)`);
        }
        await store.setFocus(itemId);
        return { focus: itemId };
    }

    async function pin(itemId) {
        // RT-W10-05: pin cap enforced
        const items = await store.getItems();
        const item = items.find(i => i.itemId === itemId);
        if (!item) throw new Error(`Item '${itemId}' not found`);
        const pinnedCount = items.filter(i => i.pinned).length;
        if (!item.pinned && pinnedCount >= bounds.MAX_PINS) {
            throw new Error(`Pin cap (${bounds.MAX_PINS}) reached — pin refused (W10-L1/RT-W10-05)`);
        }
        item.pinned = true;
        await store.putItems(items);
        return { itemId, pinned: true };
    }

    async function unpin(itemId) {
        const items = await store.getItems();
        const item = items.find(i => i.itemId === itemId);
        if (!item) throw new Error(`Item '${itemId}' not found`);
        item.pinned = false;
        await store.putItems(items);
        return { itemId, pinned: false };
    }

    async function checkFreshness(itemId) {
        // RT-W10-04: stale projections must be exposed as STALE_REF
        const items = await store.getItems();
        const item = items.find(i => i.itemId === itemId);
        if (!item) throw new Error(`Item '${itemId}' not found`);
        const age = Date.now() - item.freshness;
        if (age > bounds.FRESHNESS_TTL_MS) {
            item.freshnessState = "STALE_REF";
            await store.putItems(items);
        }
        return item.freshnessState;
    }

    async function getAssembly() {
        const items = await store.getItems();
        return assembly.getAssembly(items);
    }

    async function getPool() {
        return store.getItems();
    }

    async function getEvictions() {
        return store.getEvictions();
    }

    async function getFocus() {
        return store.getFocus();
    }

    return { admit, evict: evictItem, setFocus, pin, unpin, checkFreshness, getAssembly, getPool, getEvictions, getFocus };
}

module.exports = { makeWorkspace };
