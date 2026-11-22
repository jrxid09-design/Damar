"use strict";

function makeEviction(store) {
    async function evict(itemId, reason) {
        const items = await store.getItems();
        const idx = items.findIndex(i => i.itemId === itemId);
        if (idx === -1) throw new Error(`Item '${itemId}' not found for eviction`);
        items.splice(idx, 1);
        await store.putItems(items);
        // RT-W10-06: every eviction is audited, never hidden
        await store.addEviction({ itemId, reason: reason || "evicted", evictedAt: Date.now() });
        return { itemId, evicted: true };
    }

    return { evict };
}

module.exports = { makeEviction };
