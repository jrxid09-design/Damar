"use strict";

const { BOUNDS, QUARANTINE_SCHEMA_VERSION } = require("./bounds");

function makeQuarantine(store) {
    async function addAssertion(agentId, assertion) {
        const count = await store.getKv("quarantine:count") || 0;
        if (count >= BOUNDS.MAX_QUARANTINED_ASSERTIONS) {
            throw new Error("MAX_QUARANTINED_ASSERTIONS reached — assertion refused");
        }
        const id = `${agentId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const record = {
            schemaVersion: QUARANTINE_SCHEMA_VERSION,
            agentId,
            assertion,
            addedAt: Date.now(),
            expiresAt: Date.now() + BOUNDS.QUARANTINE_ASSERTION_TTL_MS,
            corroborated: false,
            corroboratedAt: null,
        };
        await store.putKv(`quarantine:assert:${id}`, record);
        await store.putKv("quarantine:count", count + 1);
        return { id, record };
    }

    async function corroborate(id) {
        const key = `quarantine:assert:${id}`;
        const record = await store.getKv(key);
        if (!record) throw new Error(`Quarantined assertion ${id} not found`);
        const updated = Object.assign({}, record, {
            corroborated: true,
            corroboratedAt: Date.now(),
        });
        await store.putKv(key, updated);
        return updated;
    }

    return { addAssertion, corroborate };
}

module.exports = { makeQuarantine };
