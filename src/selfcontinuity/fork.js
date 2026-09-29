"use strict";

function makeForkOps(store) {
    async function recordFork(identity, forkInstanceId, ownerConsent) {
        // RT-W10-13: silent fork merge forbidden — owner consent required
        if (!ownerConsent) {
            throw new Error("Silent fork merge forbidden — owner consent required (W10-L2/RT-W10-13)");
        }
        const fork = {
            identityId: identity.identityId,
            forkInstanceId,
            generation: identity.generation,
            mergedAt: Date.now(),
            ownerConsent: true,
        };
        await store.addFork(fork);
        return fork;
    }
    return { recordFork };
}

module.exports = { makeForkOps };
