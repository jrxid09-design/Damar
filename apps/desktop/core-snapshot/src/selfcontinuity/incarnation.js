"use strict";

function makeIncarnationOps(store, bounds) {
    async function recordIncarnation(identity, instanceId) {
        const incarnations = await store.getIncarnations();
        if (incarnations.length >= bounds.MAX_INCARNATIONS) {
            throw new Error(`Incarnation limit (${bounds.MAX_INCARNATIONS}) reached`);
        }
        const incarnation = {
            identityId: identity.identityId,
            instanceId,
            generation: identity.generation,
            startedAt: Date.now(),
        };
        await store.addIncarnation(incarnation);
        return incarnation;
    }

    async function detectFork(identity, instanceId) {
        // RT-W10-12: same generation, different instanceId → forked
        const incarnations = await store.getIncarnations();
        const concurrent = incarnations.filter(
            i => i.generation === identity.generation && i.instanceId !== instanceId
        );
        if (concurrent.length > 0) {
            return { forked: true, instances: [instanceId, ...concurrent.map(i => i.instanceId)] };
        }
        return { forked: false };
    }

    return { recordIncarnation, detectFork };
}

module.exports = { makeIncarnationOps };
