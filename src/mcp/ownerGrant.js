"use strict";

/*
 * PROTOTYPE — ISOLATED, NOT WIRED INTO PRODUCTION COMPOSITION.
 *
 * Owner-grant evidence for the MCP worker principal (design:
 * docs/mcp-lane2-owner-grant-design.md). This module implements and proves
 * the grant mechanics ONLY: an owner-signed, expiring, scope-capped grant
 * bound to a worker Ed25519 key, presented with a one-use proof of
 * possession. It does NOT authenticate anyone to Lane 2 by itself —
 * production use requires the (separately ratified) Lane 2 verifier change
 * described in the design doc. Nothing in src/mcp/index.js imports this
 * file yet, and tools/call remains fail-closed without it.
 *
 * Alignment with existing Damar law:
 *  - AGENT_SCOPE_REQUIRES_OWNER_GRANT: no scope exists without an owner
 *    signature over the exact grant payload.
 *  - EXTERNAL_AGENT_OUTPUT_IS_NOT_AUTHORITY: a valid grant mints at most a
 *    least-privilege worker principal; every action still passes the
 *    Authority Gate (Lane 2 evaluate) downstream.
 *  - Fail-closed: every anomaly returns a frozen deny verdict; nothing
 *    throws across the authorize() boundary.
 */

const crypto = require("node:crypto");

const GRANT_VERSION = "mcp-owner-grant.v1";
// Mirrors the agentfed scope TTL bound (AGENT_SCOPE_TTL_MS, 90 days).
const MAX_TTL_MS = 90 * 24 * 3600 * 1000;
const POP_NONCE_TTL_MS = 5 * 60 * 1000;

// The hard ceiling for ANY MCP worker grant: the Manager intent surface
// plus nothing else. A grant can only ever narrow this list.
const HARD_ALLOWLIST = Object.freeze([
    "damar.submit_intent",
    "damar.get_task_status",
    "damar.cancel_task",
    "damar.list_capabilities"
]);

function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function deny(reasonCode) {
    return Object.freeze({ ok: false, reasonCode });
}

function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateScope(scope) {
    if (!Array.isArray(scope) || scope.length === 0) return "GRANT_SCOPE_EMPTY";
    for (const tool of scope) {
        if (typeof tool !== "string" || !HARD_ALLOWLIST.includes(tool)) return "GRANT_SCOPE_EXCEEDS_ALLOWLIST";
    }
    if (new Set(scope).size !== scope.length) return "GRANT_SCOPE_DUPLICATE";
    return null;
}

/**
 * Issue a grant. Owner-side only: in production this runs behind the
 * Console owner proof ceremony (or an offline owner CLI); the owner
 * private key never leaves that surface. Throws on invalid input —
 * issuance is an owner action, not a request boundary.
 */
function issueOwnerGrant({ ownerPrivateKeyPem, subject, workerPublicKeyPem, scope, ttlMs, nowMs, agentId = null, maxExecutions = null } = {}) {
    if (typeof subject !== "string" || subject.trim() === "" || subject.length > 256) throw new TypeError("grant subject must be a non-empty string");
    if (typeof workerPublicKeyPem !== "string" || !workerPublicKeyPem.includes("PUBLIC KEY")) throw new TypeError("workerPublicKeyPem must be a PEM public key");
    const scopeError = validateScope(scope);
    if (scopeError) throw new TypeError(`invalid grant scope: ${scopeError}`);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) throw new TypeError("grant ttlMs must be within (0, MAX_TTL_MS]");
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new TypeError("nowMs must be a positive integer");
    if (agentId !== null && (typeof agentId !== "string" || agentId.length > 128)) throw new TypeError("agentId must be a string or null");
    if (maxExecutions !== null && (!Number.isSafeInteger(maxExecutions) || maxExecutions <= 0)) throw new TypeError("maxExecutions must be a positive integer or null");
    const grant = Object.freeze({
        version: GRANT_VERSION,
        grantId: crypto.randomUUID(),
        subject,
        agentId,
        workerPublicKeyPem,
        scope: Object.freeze([...scope]),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        maxExecutions
    });
    const signature = crypto.sign(null, Buffer.from(canonicalJson(grant), "utf8"), crypto.createPrivateKey(ownerPrivateKeyPem)).toString("base64url");
    return Object.freeze({ grant, signature });
}

function verifyOwnerGrant({ grant, signature, ownerPublicKeyPem, nowMs } = {}) {
    if (!isPlainObject(grant) || typeof signature !== "string") return deny("GRANT_MALFORMED");
    if (grant.version !== GRANT_VERSION) return deny("GRANT_VERSION_UNSUPPORTED");
    if (typeof grant.grantId !== "string" || typeof grant.subject !== "string" || grant.subject.trim() === "") return deny("GRANT_MALFORMED");
    if (typeof grant.workerPublicKeyPem !== "string" || !grant.workerPublicKeyPem.includes("PUBLIC KEY")) return deny("GRANT_MALFORMED");
    if (!Number.isSafeInteger(grant.issuedAtMs) || !Number.isSafeInteger(grant.expiresAtMs)) return deny("GRANT_MALFORMED");
    if (grant.expiresAtMs <= grant.issuedAtMs || grant.expiresAtMs - grant.issuedAtMs > MAX_TTL_MS) return deny("GRANT_TTL_INVALID");
    const scopeError = validateScope(grant.scope);
    if (scopeError) return deny(scopeError);
    if (!Number.isSafeInteger(nowMs)) return deny("GRANT_MALFORMED");
    if (nowMs < grant.issuedAtMs) return deny("GRANT_NOT_YET_VALID");
    if (nowMs >= grant.expiresAtMs) return deny("GRANT_EXPIRED");
    let ok = false;
    try {
        ok = crypto.verify(null, Buffer.from(canonicalJson(grant), "utf8"), crypto.createPublicKey(ownerPublicKeyPem), Buffer.from(signature, "base64url"));
    } catch {
        return deny("GRANT_SIGNATURE_INVALID");
    }
    if (!ok) return deny("GRANT_SIGNATURE_INVALID");
    return Object.freeze({ ok: true, principal: grant.subject, agentId: grant.agentId ?? null, scope: Object.freeze([...grant.scope]), grantId: grant.grantId, expiresAtMs: grant.expiresAtMs });
}

/**
 * Request-boundary gate (prototype of the A3 policy core). Holds one-use
 * proof-of-possession nonces server-side. authorize() never throws.
 */
function createGrantGate({ ownerPublicKeyPem, now = () => Date.now() } = {}) {
    if (typeof ownerPublicKeyPem !== "string" || !ownerPublicKeyPem.includes("PUBLIC KEY")) throw new TypeError("ownerPublicKeyPem must be a PEM public key");
    const nonces = new Map(); // nonce -> expiresAtMs

    function issueChallenge() {
        const t = now();
        for (const [nonce, exp] of nonces) if (exp <= t) nonces.delete(nonce);
        const nonce = crypto.randomBytes(32).toString("base64url");
        nonces.set(nonce, t + POP_NONCE_TTL_MS);
        return Object.freeze({ nonce, expiresAtMs: t + POP_NONCE_TTL_MS });
    }

    function authorize({ grant, signature, toolId, pop } = {}) {
        const verdict = verifyOwnerGrant({ grant, signature, ownerPublicKeyPem, nowMs: now() });
        if (!verdict.ok) return verdict;
        if (typeof toolId !== "string" || !HARD_ALLOWLIST.includes(toolId)) return deny("TOOL_OUTSIDE_HARD_ALLOWLIST");
        if (!verdict.scope.includes(toolId)) return deny("TOOL_NOT_IN_GRANT_SCOPE");
        if (!isPlainObject(pop) || typeof pop.nonce !== "string" || typeof pop.signature !== "string") return deny("POP_MISSING");
        const nonceExpiry = nonces.get(pop.nonce);
        if (nonceExpiry === undefined || nonceExpiry <= now()) return deny("POP_NONCE_INVALID");
        nonces.delete(pop.nonce); // one-use: consumed even if the signature fails
        let popOk = false;
        try {
            const payload = canonicalJson({ grantId: grant.grantId, nonce: pop.nonce, toolId });
            popOk = crypto.verify(null, Buffer.from(payload, "utf8"), crypto.createPublicKey(grant.workerPublicKeyPem), Buffer.from(pop.signature, "base64url"));
        } catch {
            return deny("POP_INVALID");
        }
        if (!popOk) return deny("POP_INVALID");
        return Object.freeze({ ok: true, principal: verdict.principal, agentId: verdict.agentId, grantId: verdict.grantId, toolId });
    }

    return Object.freeze({ issueChallenge, authorize });
}

/**
 * Production verifier for the ratified 'grant-proof' evidence kind
 * (Lane 2, ratified 2026-11-23). The grant itself is NEVER trusted from the
 * wire: it is rehydrated from the grant store by grantId, so revocation and
 * expiry reflect current store state. Verification = owner signature +
 * scope + one-use PoP nonce, via the same gate the prototype proved.
 * grantStore: { get(grantId) -> { grant, signature, revoked } | null } -
 * SYNCHRONOUS, like the rest of the canonical verifier (the composition
 * keeps a rehydrated snapshot). verify() never throws; any failure is
 * null (fail-closed).
 */
function makeGrantVerifier({ ownerPublicKeyPem, grantStore, now = () => Date.now() } = {}) {
    if (!grantStore || typeof grantStore.get !== "function") throw new TypeError("makeGrantVerifier requires a grantStore with get(grantId)");
    const gate = createGrantGate({ ownerPublicKeyPem, now });
    function verify(evidence) {
        try {
            if (!evidence || typeof evidence !== "object") return null;
            if (typeof evidence.grantId !== "string" || typeof evidence.toolId !== "string") return null;
            const rec = grantStore.get(evidence.grantId);
            if (!rec || rec.revoked || !rec.grant || typeof rec.signature !== "string") return null;
            const pop = { nonce: evidence.popNonce, signature: evidence.popSignature };
            const verdict = gate.authorize({ grant: rec.grant, signature: rec.signature, toolId: evidence.toolId, pop });
            if (!verdict.ok) return null;
            return Object.freeze({ principal: verdict.principal, agentId: verdict.agentId, grantId: verdict.grantId, toolId: verdict.toolId, scope: Object.freeze([...rec.grant.scope]) });
        } catch {
            return null;
        }
    }
    return Object.freeze({ verify, issueChallenge: () => gate.issueChallenge(), gate });
}

module.exports = { GRANT_VERSION, HARD_ALLOWLIST, MAX_TTL_MS, canonicalJson, issueOwnerGrant, verifyOwnerGrant, createGrantGate, makeGrantVerifier };
