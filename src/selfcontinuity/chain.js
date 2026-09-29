"use strict";

const { CONTINUITY_LEVELS } = require("./levels");

function makeChainOps(store) {
    async function advanceGeneration(identity, reason) {
        const chain = await store.getChain();
        const nextGen = identity.generation + 1;
        if (chain.length > 0) {
            const lastEntry = chain[chain.length - 1];
            if (nextGen <= lastEntry.generation) {
                throw new Error(`Generation must be monotonically increasing — regression refused (W10-L2/RT-W10-15)`);
            }
        }
        const entry = {
            generation: nextGen,
            reason: reason || "advance",
            recordedAt: Date.now(),
            continuityLevel: CONTINUITY_LEVELS.FULL,
        };
        await store.addChainEntry(entry);
        identity.generation = nextGen;
        await store.putIdentity(identity);
        return entry;
    }

    async function detectPartial(identity) {
        // RT-W10-17: gap between stored chain and identity generation → PARTIAL
        const chain = await store.getChain();
        if (chain.length === 0) return CONTINUITY_LEVELS.FULL;
        const lastEntry = chain[chain.length - 1];
        if (identity.generation > lastEntry.generation + 1) {
            return CONTINUITY_LEVELS.PARTIAL;
        }
        return CONTINUITY_LEVELS.FULL;
    }

    return { advanceGeneration, detectPartial };
}

module.exports = { makeChainOps };
