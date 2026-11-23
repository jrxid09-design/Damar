"use strict";
// MCP Lane 2 adapter (ratified 2026-11-23): the legal path from an external
// MCP client's tools/call to a Manager session. The four intent tools
// (HARD_ALLOWLIST in ownerGrant.js) are projected here; every call must carry
// grant evidence in arguments.__grant ({ grantId, popNonce, popSignature }).
// The adapter builds a ManagerRequest whose authProof is the new
// 'grant-proof' evidence kind; the canonical verifier rehydrates the grant
// from the store and checks the owner signature + scope + one-use PoP nonce.
// Without evidence - or without a composed grant lane - execution stays
// fail-closed (the caller keeps the legacy rejection). The adapter holds no
// authority: the Manager + Authority Gate decide everything downstream.
const { HARD_ALLOWLIST } = require("./ownerGrant");

const CHALLENGE_TOOL = "damar.grant_challenge";

const INTENT_DESCRIPTORS = Object.freeze([
    ...HARD_ALLOWLIST.map((id) => ({
        id,
        description: `Manager intent via owner grant (Lane 2): ${id}`,
        parameters: { type: "object", properties: { __grant: { type: "object" } } },
    })),
    {
        id: CHALLENGE_TOOL,
        description: "Issue a one-use proof-of-possession challenge nonce for an owner grant (Lane 2).",
        parameters: { type: "object", properties: {} },
    },
]);

function createManagerAdapter({ managerHandle, grantVerifier } = {}) {
    if (typeof managerHandle !== "function") throw new TypeError("managerAdapter requires a managerHandle function");
    if (!grantVerifier || typeof grantVerifier.verify !== "function" || typeof grantVerifier.issueChallenge !== "function") {
        throw new TypeError("managerAdapter requires a grantVerifier (see ownerGrant.makeGrantVerifier)");
    }
    const isIntentTool = (id) => HARD_ALLOWLIST.includes(id);
    const isAdapterTool = (id) => isIntentTool(id) || id === CHALLENGE_TOOL;

    async function execute(id, args = {}, ctx = {}) {
        if (id === CHALLENGE_TOOL) return grantVerifier.issueChallenge();
        if (!isIntentTool(id)) {
            const e = new Error(`NOT_AN_INTENT_TOOL: ${id}`);
            e.code = "NOT_AN_INTENT_TOOL";
            throw e;
        }
        const ev = args && typeof args === "object" ? args.__grant : null;
        if (!ev || typeof ev.grantId !== "string" || typeof ev.popNonce !== "string" || typeof ev.popSignature !== "string") {
            const e = new Error("GRANT_EVIDENCE_REQUIRED: tools/call for intent tools must carry arguments.__grant { grantId, popNonce, popSignature }");
            e.code = "GRANT_EVIDENCE_REQUIRED";
            throw e;
        }
        const { __grant, ...cleanArgs } = args;
        const request = {
            sessionId: typeof ctx?.exec?.sessionId === "string" ? ctx.exec.sessionId : "mcp",
            channelType: "mcp",
            channelId: "mcp",
            peer: "mcp",
            correlationId: `mcp-${Date.now()}`,
            authProof: {
                kind: "grant-proof",
                grantId: ev.grantId,
                toolId: id,
                popNonce: ev.popNonce,
                popSignature: ev.popSignature,
            },
            // Lane 2 policy evaluates payload.action against the grant scope
            // (defense in depth beside the verifier's own scope check).
            payload: { action: id, arguments: cleanArgs },
        };
        return managerHandle(request);
    }

    return Object.freeze({ isIntentTool, isAdapterTool, execute, descriptors: INTENT_DESCRIPTORS, CHALLENGE_TOOL });
}

module.exports = { createManagerAdapter, INTENT_DESCRIPTORS, CHALLENGE_TOOL };
