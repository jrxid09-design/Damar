"use strict";

/**
 * AUTHORITY V1 — canonical read-only authorization evaluation.
 *
 * This is the SINGLE source of truth for grant validation semantics. Both
 * AuthorityRegistry.authorize() (mutating path) and the Wave-4 Lane-2
 * ActionAuthorityGate (read-only path) delegate to this primitive, so the two
 * can never drift.
 *
 *   authorize()   -> evaluateAuthorityReadOnly() -> append audit event + snapshot
 *   Lane 2 gate   -> evaluateAuthorityReadOnly() -> (no mutation)
 *
 * SEMANTICS (identical to the historical authorize() grant checks):
 *   - canonicalize capabilityId / action / scope (fail-closed CAP_MALFORMED)
 *   - capability exists (CAP_NOT_FOUND)
 *   - generation staleness (CAP_GENERATION_STALE)
 *   - status (SUSPENDED/REVOKED/EXHAUSTED/other -> deny)
 *   - notBefore / expiresAt
 *   - action membership (CAP_ACTION_DENIED)
 *   - scope membership (CAP_SCOPE_MISMATCH)
 *   - purpose membership (CAP_PURPOSE_MISMATCH)
 *   - identity binding (channel/session/principal) (CAP_IDENTITY_MISMATCH)
 *   - budget via countConsumption (CAP_BUDGET_EXHAUSTED)
 *
 * FAIL-CLOSED: any store read failure (getCapability/getGeneration/
 * countConsumption throwing), malformed persisted grant state, or unknown
 * budget result is a DENY (CAP_MALFORMED / CAP_BUDGET_EXHAUSTED), NEVER a
 * silent substitution of a positive result.
 */

const { canonicalCapabilityId, canonicalTokenList } = require("./canonical");

const EVAL_REASONS = Object.freeze({
    AUTHORIZED: "AUTHORIZED",
    CAP_NOT_FOUND: "CAP_NOT_FOUND",
    CAP_GENERATION_STALE: "CAP_GENERATION_STALE",
    CAP_INACTIVE: "CAP_INACTIVE",
    CAP_REVOKED: "CAP_REVOKED",
    CAP_EXPIRED: "CAP_EXPIRED",
    CAP_EXHAUSTED: "CAP_EXHAUSTED",
    CAP_ACTION_DENIED: "CAP_ACTION_DENIED",
    CAP_SCOPE_MISMATCH: "CAP_SCOPE_MISMATCH",
    CAP_PURPOSE_MISMATCH: "CAP_PURPOSE_MISMATCH",
    CAP_IDENTITY_MISMATCH: "CAP_IDENTITY_MISMATCH",
    CAP_BUDGET_EXHAUSTED: "CAP_BUDGET_EXHAUSTED",
    CAP_MALFORMED: "CAP_MALFORMED"
});

function deny(reasonCode, detail = null) {
    return { allowed: false, reasonCode, detail: detail ?? null, snapshot: null };
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * Canonical read-only authorization evaluation over an Authority store.
 *
 * @param {object} store   Authority store with read methods:
 *   getCapability(capabilityId) -> { status, generation, payload } | null
 *   getGeneration(subject) -> number
 *   countConsumption(capabilityId) -> number
 * @param {object} request
 *   { capabilityId, action, scope?, purpose?, identity? {channel, sessionId,
 *     principal}, nowMs? }
 * @param {object} [opts] { nowMs } default clock value when request.nowMs absent
 * @returns {Promise<{allowed, reasonCode, detail, snapshot}>}
 */
async function evaluateAuthorityReadOnly(store, request = {}, { nowMs = null } = {}) {
    const atMs = (request.nowMs === null || request.nowMs === undefined) ? nowMs : request.nowMs;

    let capId;
    let reqAction;
    let reqScope;
    try {
        capId = canonicalCapabilityId(request.capabilityId);
        reqAction = String(request.action ?? "").trim().toLowerCase();
        reqScope = canonicalTokenList(request.scope ?? [], "scope");
    } catch (error) {
        return deny(EVAL_REASONS.CAP_MALFORMED, error.message);
    }

    // Fail closed on store read errors: a throwing store is never a positive.
    let cap;
    try {
        cap = await store.getCapability(capId);
    } catch (error) {
        return deny(EVAL_REASONS.CAP_MALFORMED, "authority store getCapability failed");
    }
    if (!cap) return deny(EVAL_REASONS.CAP_NOT_FOUND);

    const g = cap.payload;
    if (!g || typeof g !== "object" || Array.isArray(g) || typeof g.subject !== "string") {
        return deny(EVAL_REASONS.CAP_MALFORMED, "persisted grant payload is malformed");
    }

    let curGen;
    try {
        curGen = await store.getGeneration(g.subject);
    } catch (error) {
        return deny(EVAL_REASONS.CAP_MALFORMED, "authority store getGeneration failed");
    }
    if (curGen !== cap.generation) {
        return deny(EVAL_REASONS.CAP_GENERATION_STALE, `gen ${cap.generation} != current ${curGen}`);
    }

    if (cap.status === "SUSPENDED") return deny(EVAL_REASONS.CAP_INACTIVE);
    if (cap.status === "REVOKED") return deny(EVAL_REASONS.CAP_REVOKED);
    if (cap.status === "EXHAUSTED") return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED);
    if (cap.status !== "ACTIVE") return deny(EVAL_REASONS.CAP_INACTIVE, `status ${String(cap.status)}`);

    if (g.notBefore && atMs < Date.parse(g.notBefore)) return deny(EVAL_REASONS.CAP_INACTIVE, g.notBefore);
    if (g.expiresAt && atMs > Date.parse(g.expiresAt)) return deny(EVAL_REASONS.CAP_EXPIRED, g.expiresAt);

    const actions = Array.isArray(g.actions) ? g.actions.map((a) => String(a).trim().toLowerCase()) : [];
    if (!actions.includes(reqAction)) return deny(EVAL_REASONS.CAP_ACTION_DENIED, reqAction);

    const grantScope = Array.isArray(g.scope) ? g.scope.map((s) => String(s).trim().toLowerCase()) : [];
    // Fail closed: an empty (unresolved) request scope cannot satisfy a scoped
    // grant. A scoped grant requires the request to carry at least one in-scope
    // token (no implicit "unrestricted" pass-through).
    if (grantScope.length && reqScope.length === 0) {
        return deny(EVAL_REASONS.CAP_SCOPE_MISMATCH, "(empty scope)");
    }
    for (const token of reqScope) {
        if (grantScope.length && !grantScope.includes(token)) {
            return deny(EVAL_REASONS.CAP_SCOPE_MISMATCH, token);
        }
    }

    const allowedPurposes = Array.isArray(g.allowedPurposes) ? g.allowedPurposes.map((s) => String(s).trim().toLowerCase()) : [];
    const purpose = request.purpose ?? null;
    if (purpose !== null && purpose !== undefined) {
        const p = String(purpose).trim().toLowerCase();
        if (allowedPurposes.length && !allowedPurposes.includes(p)) {
            return deny(EVAL_REASONS.CAP_PURPOSE_MISMATCH, p);
        }
    } else if (allowedPurposes.length) {
        return deny(EVAL_REASONS.CAP_PURPOSE_MISMATCH, "(empty)");
    }

    const identity = request.identity || {};
    const ib = g.identityBinding;
    if (ib && typeof ib === "object") {
        const channel = String(identity.channel ?? "").toLowerCase();
        if (Array.isArray(ib.channels) && ib.channels.length && !ib.channels.includes(channel)) {
            return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "channel");
        }
        if (Array.isArray(ib.sessionIds) && ib.sessionIds.length && !ib.sessionIds.includes(String(identity.sessionId ?? ""))) {
            return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "sessionId");
        }
        if (Array.isArray(ib.principals) && ib.principals.length && !ib.principals.includes(String(identity.principal ?? ""))) {
            return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "principal");
        }
    }

    if (typeof g.maxExecutions === "number") {
        let used;
        try {
            used = await store.countConsumption(capId);
        } catch (error) {
            // Fail closed: a read error is never "used = 0".
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, "authority store countConsumption failed");
        }
        if (typeof used !== "number" || !Number.isFinite(used)) {
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, "authority store returned non-numeric consumption");
        }
        if (used >= g.maxExecutions) {
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, `${used}/${g.maxExecutions}`);
        }
    }

    const snapshot = deepFreeze({
        capabilityId: capId,
        subject: g.subject,
        kind: g.kind,
        principal: String(identity.principal ?? "").trim().toLowerCase(),
        channel: String(identity.channel ?? "").trim().toLowerCase(),
        sessionId: String(identity.sessionId ?? "").trim().toLowerCase(),
        actions: Object.freeze([...actions]),
        scope: Object.freeze([...reqScope]),
        allowedPurposes: Object.freeze([...allowedPurposes]),
        purpose: purpose === null || purpose === undefined ? null : String(purpose).trim().toLowerCase(),
        identityBinding: g.identityBinding ? deepFreeze(JSON.parse(JSON.stringify(g.identityBinding))) : null,
        maxExecutions: g.maxExecutions,
        expiresAt: g.expiresAt,
        generation: cap.generation,
        rootCapabilityId: g.rootCapabilityId,
        parentCapabilityId: g.parentCapabilityId,
        ratificationId: g.ratificationId,
        issuedAt: g.issuedAt,
        evaluatedAtMs: atMs
    });

    return { allowed: true, reasonCode: EVAL_REASONS.AUTHORIZED, snapshot };
}

module.exports = { evaluateAuthorityReadOnly, EVAL_REASONS };
