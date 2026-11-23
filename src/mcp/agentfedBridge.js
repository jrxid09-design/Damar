"use strict";
// agentfed wiring bridge (B1/B3/B5 of the MCP worker brief): instantiates
// the federation layer inside the MCP composition and binds MCP sessions to
// agent identities THROUGH owner grants - never through self-assertion.
//   B1: makeAgentFed(acc) is composed here, beside the MCP adapter; the
//       bridge creates no authority (federation output stays T5/advisory).
//   B3: a session may claim an agentId only when its owner grant names the
//       same agentId (identityBinding inside the signed grant).
//   B5: AGENT_SCOPE_REQUIRES_OWNER_GRANT - the grant signature must verify,
//       its scope must stay inside the hard allowlist, and its TTL is the
//       grant's own expiry (<= 90 days, enforced at issuance).
//   B4: outbound payloads route through the federation egress redactor.
const { makeAgentFed } = require("../agentfed");
const { verifyOwnerGrant, HARD_ALLOWLIST } = require("./ownerGrant");

function createAgentfedBridge({ acc, ownerPublicKeyPem, now = () => Date.now() } = {}) {
    if (!acc || typeof acc.getKv !== "function" || typeof acc.putKv !== "function") {
        throw new TypeError("agentfedBridge requires an acc store ({ getKv, putKv })");
    }
    if (typeof ownerPublicKeyPem !== "string" || !ownerPublicKeyPem.includes("PUBLIC KEY")) {
        throw new TypeError("agentfedBridge requires the owner public key PEM");
    }
    const fed = makeAgentFed(acc);

    function bindSession({ agentId, grant, signature } = {}) {
        const verdict = verifyOwnerGrant({ grant, signature, ownerPublicKeyPem, nowMs: now() });
        if (!verdict.ok) return Object.freeze({ ok: false, reason: verdict.reason || "GRANT_INVALID" });
        if (typeof agentId !== "string" || !grant.agentId || grant.agentId !== agentId) {
            return Object.freeze({ ok: false, reason: "AGENT_BINDING_MISMATCH" });
        }
        if (!Array.isArray(grant.scope) || !grant.scope.every((a) => HARD_ALLOWLIST.includes(a))) {
            return Object.freeze({ ok: false, reason: "SCOPE_OUTSIDE_ALLOWLIST" });
        }
        return Object.freeze({ ok: true, principal: verdict.principal, agentId, scope: verdict.scope, grantId: verdict.grantId, expiresAtMs: verdict.expiresAtMs });
    }

    // B4: anything leaving toward an external agent passes the egress
    // redactor first (internal state / credentials never cross).
    function egressPayload(agentId, payload) {
        return fed.egress.send(agentId, payload);
    }

    return Object.freeze({ fed, bindSession, egressPayload });
}

module.exports = { createAgentfedBridge };
