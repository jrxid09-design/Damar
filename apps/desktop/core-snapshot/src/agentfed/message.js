"use strict";

const { BOUNDS, MESSAGE_SCHEMA_VERSION } = require("./bounds");
const { STATES } = require("./agent");

const FORBIDDEN_MUTATION_KEYS = new Set(["trust", "authority", "capabilities", "budget", "nodeMembership"]);

function assertNotSelfElevation(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    for (const key of FORBIDDEN_MUTATION_KEYS) {
        if (key in payload) {
            throw new Error(
                `Agent message may not mutate '${key}' (W9-L2 FORBIDDEN_OWNER_MUTATION)`
            );
        }
    }
}

function validatePayload(payload) {
    if (payload === null || payload === undefined) return;
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > BOUNDS.MAX_PAYLOAD_BYTES) {
        throw new Error(`Message payload exceeds MAX_PAYLOAD_BYTES (${BOUNDS.MAX_PAYLOAD_BYTES})`);
    }
}

function makeMessageHandler(store) {
    const windowMap = new Map(); // agentId → { count, windowStart }

    function checkFloodLimit(agentId) {
        const now = Date.now();
        let w = windowMap.get(agentId);
        if (!w || (now - w.windowStart) > BOUNDS.MAX_FLOOD_WINDOW_MS) {
            w = { count: 0, windowStart: now };
            windowMap.set(agentId, w);
        }
        w.count++;
        if (w.count > BOUNDS.MAX_INBOUND_MESSAGES_PER_AGENT_PER_HOUR) {
            throw new Error(`Agent ${agentId} exceeded flood limit (W9-L2)`);
        }
    }

    async function receive(agentId, rawPayload) {
        const record = await store.getAgent(agentId);
        if (!record || record.state !== STATES.ENABLED) {
            throw new Error(`Agent ${agentId} not enabled — message refused`);
        }
        checkFloodLimit(agentId);
        validatePayload(rawPayload);
        assertNotSelfElevation(rawPayload);
        return {
            schemaVersion: MESSAGE_SCHEMA_VERSION,
            tier: "T5",
            agentId,
            receivedAt: Date.now(),
            payload: rawPayload,
            corroborated: false,
        };
    }

    return { receive };
}

module.exports = { makeMessageHandler, validatePayload, assertNotSelfElevation };
