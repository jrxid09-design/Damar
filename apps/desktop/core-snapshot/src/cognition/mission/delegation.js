"use strict";

const DELEGATION_SCHEMA_VERSION = "mission.delegation.v1";
const ALLOWED_MODES = new Set(["REQUEST"]);

function makeDelegation(store) {
    async function create(missionId, opts = {}) {
        const mode = opts.mode || "REQUEST";
        if (!ALLOWED_MODES.has(mode)) {
            throw new Error(
                `Delegation TRANSFER mode refused — delegation is request-only; authority never travels (W9-L1/ADR-09/RT-W9-10)`
            );
        }
        const id = `del:${missionId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const record = {
            schemaVersion: DELEGATION_SCHEMA_VERSION,
            delegationId: id, missionId, mode,
            to: opts.to || null, createdAt: Date.now(),
        };
        await store.putKv(`delegation:${id}`, record);
        await store.addToIndex(`delegations:${missionId}`, id);
        return record;
    }
    return { create };
}

module.exports = { makeDelegation };
