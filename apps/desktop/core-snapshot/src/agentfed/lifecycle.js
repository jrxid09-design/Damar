"use strict";

const { STATES, assertTransitionAllowed, validateAgentId } = require("./agent");

function makeLifecycle(store) {
    async function register(agentId, contract) {
        validateAgentId(agentId);
        const existing = await store.getAgent(agentId);
        if (existing) {
            if (existing.state === STATES.REVOKED) {
                throw new Error(`Agent identity ${agentId} is revoked and cannot be reused`);
            }
            throw new Error(`Agent ${agentId} already registered with state ${existing.state}`);
        }
        const record = {
            agentId,
            state: STATES.DISCOVERED,
            contract: contract || null,
            registeredAt: Date.now(),
            enabledAt: null,
            revokedAt: null,
        };
        await store.putAgent(agentId, record);
        return record;
    }

    async function transition(agentId, toState, { ownerApproval = false } = {}) {
        validateAgentId(agentId);
        const record = await store.getAgent(agentId);
        if (!record) throw new Error(`Agent ${agentId} not found`);
        assertTransitionAllowed(record.state, toState);
        if (toState === STATES.ENABLED && !ownerApproval) {
            throw new Error("Agent self-enable refused: owner approval required (W9-L2 law)");
        }
        const updated = Object.assign({}, record, {
            state: toState,
            enabledAt:  toState === STATES.ENABLED ? Date.now() : record.enabledAt,
            revokedAt:  toState === STATES.REVOKED  ? Date.now() : record.revokedAt,
        });
        await store.putAgent(agentId, updated);
        return updated;
    }

    async function revoke(agentId) {
        return transition(agentId, STATES.REVOKED, { ownerApproval: true });
    }

    async function getAgent(agentId) {
        validateAgentId(agentId);
        return store.getAgent(agentId);
    }

    return { register, transition, revoke, getAgent };
}

module.exports = { makeLifecycle };
