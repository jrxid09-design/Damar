"use strict";

const { BOUNDS } = require("./bounds");

const P = "agentfed:";

function makeAgentFedStore(acc) {
    async function getAgent(agentId) {
        return acc.getKv(`${P}agent:${agentId}`);
    }

    async function putAgent(agentId, record) {
        const index = await acc.getKv(`${P}index`) || [];
        if (!index.includes(agentId)) {
            if (index.length >= BOUNDS.MAX_KNOWN_AGENTS) {
                throw new Error(`MAX_KNOWN_AGENTS (${BOUNDS.MAX_KNOWN_AGENTS}) reached`);
            }
            index.push(agentId);
            await acc.putKv(`${P}index`, index);
        }
        if (record.state === "ENABLED") {
            const all = await listAgents();
            const enabledCount = all.filter(a => a.state === "ENABLED" && a.agentId !== agentId).length;
            if (enabledCount >= BOUNDS.MAX_ENABLED_AGENTS) {
                throw new Error(`MAX_ENABLED_AGENTS (${BOUNDS.MAX_ENABLED_AGENTS}) reached`);
            }
        }
        return acc.putKv(`${P}agent:${agentId}`, record);
    }

    async function listAgents() {
        const index = await acc.getKv(`${P}index`) || [];
        const records = await Promise.all(index.map(id => acc.getKv(`${P}agent:${id}`)));
        return records.filter(Boolean);
    }

    async function getKv(key) {
        return acc.getKv(`${P}kv:${key}`);
    }

    async function putKv(key, value) {
        return acc.putKv(`${P}kv:${key}`, value);
    }

    return { getAgent, putAgent, listAgents, getKv, putKv };
}

module.exports = { makeAgentFedStore };
