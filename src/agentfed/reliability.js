"use strict";

function makeReliability(store) {
    async function recordSuccess(agentId) {
        const key = `reliability:${agentId}`;
        const r = await store.getKv(key) || { successes: 0, failures: 0, lastAt: null };
        r.successes++;
        r.lastAt = Date.now();
        await store.putKv(key, r);
    }

    async function recordFailure(agentId) {
        const key = `reliability:${agentId}`;
        const r = await store.getKv(key) || { successes: 0, failures: 0, lastAt: null };
        r.failures++;
        r.lastAt = Date.now();
        await store.putKv(key, r);
    }

    async function getStats(agentId) {
        return (await store.getKv(`reliability:${agentId}`)) || { successes: 0, failures: 0, lastAt: null };
    }

    return { recordSuccess, recordFailure, getStats };
}

module.exports = { makeReliability };
