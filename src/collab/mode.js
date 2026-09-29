"use strict";

const MODES = Object.freeze(["supervised", "assisted", "autonomous"]);
const MODE_RANK = Object.freeze({ supervised: 0, assisted: 1, autonomous: 2 });

function makeModeManager(store) {
    async function getMode() {
        const s = await store.getKv("mode:state");
        return s ? s.mode : "supervised";
    }

    async function setOwnerPresent(present) {
        const s = await store.getKv("mode:state") || { mode: "supervised" };
        await store.putKv("mode:state", Object.assign({}, s, { ownerPresent: present, updatedAt: Date.now() }));
    }

    async function setMode(mode) {
        if (!MODES.includes(mode)) throw new Error(`Unknown collaboration mode: ${mode}`);
        const s = await store.getKv("mode:state") || { mode: "supervised", ownerPresent: true };
        const current = s.mode || "supervised";
        const isWider = (MODE_RANK[mode] || 0) > (MODE_RANK[current] || 0);
        if (isWider && s.ownerPresent === false) {
            throw new Error(`Cannot widen collaboration scope while owner is absent (W9-L3/RT-W9-28)`);
        }
        await store.putKv("mode:state", Object.assign({}, s, { mode, updatedAt: Date.now() }));
    }

    return { getMode, setMode, setOwnerPresent };
}

module.exports = { makeModeManager };
