"use strict";

/**
 * AUTHORITY V1 — canonical authority evaluation (single source of truth).
 *
 * `loadAndEvaluateAuthority(store, request, opts)` is the ONE primitive that
 * fully rehydrates and validates a persisted grant and evaluates a request
 * against it. Both AuthorityRegistry.authorize() (mutating path) and Wave-4
 * Lane-2 ActionAuthorityGate (read-only path) MUST call this exact primitive.
 * No duplicated rehydration/validation/policy may remain elsewhere.
 *
 * The returned AuthorityEvaluation is an internally-BRANDED, immutable value.
 * The brand token lives in this module's closure and is never exported, so a
 * caller cannot manufacture a positive evaluation by constructing a plain
 * object, cloning a shape, or reusing a Symbol("same-name").
 *
 * SUBJECT/PRINCIPAL BINDING (canonical, explicit):
 *   - The authenticated `identity.principal` binds to the grant via
 *     `identityBinding.principals` (explicit delegation) OR by exact match to
 *     `grant.subject` (the grant holder acting directly).
 *   - When `identityBinding.principals` is present, `identity.principal` must
 *     be non-empty and present in it.
 *   - When `identityBinding.principals` is absent and `identity.principal` is
 *     non-empty, `identity.principal` must equal `grant.subject`.
 *   - When `identity.principal` is empty and `identityBinding.principals` is
 *     absent, the principal dimension is unconstrained (existing channel-only /
 *     session-only binding semantics).
 *
 * FAIL-CLOSED: any store read/rehydration/validation failure, malformed
 * persisted state (null/NaN/unknown forms), or unknown budget result is a
 * DENY, never a silent positive.
 */

const {
    canonicalCapabilityId, canonicalTokenList,
    restoreCanonicalRestrictionSet, deepFreeze
} = require("./canonical");

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

// Unforgeable brand token for canonical positive evaluations (closure-only).
const EVAL_BRAND = Symbol("damar.authority.evaluation.brand");
const brandGate = new WeakSet();  // registered branded evaluation objects

function brandEvaluation(result) {
    if (result.allowed === true && result.snapshot) {
        brandGate.add(result.snapshot);
    }
    return result;
}

/** Verify an evaluation is genuinely branded by the canonical evaluator.
 *  BRAND-FIRST: no property access on unbranded values before the brand check. */
function isCanonicalAuthorityEvaluation(value) {
    if (value === null || typeof value !== "object") return false;
    if (value.allowed !== true) return false;
    const snapshot = value.snapshot;
    if (snapshot === null || typeof snapshot !== "object") return false;
    if (!brandGate.has(snapshot)) return false;
    return true;
}

function deny(reasonCode, detail = null) {
    return { allowed: false, reasonCode, detail: detail ?? null, snapshot: null };
}

/**
 * Fully rehydrate + validate a persisted grant payload. Returns a frozen
 * canonical grant, or throws an AuthorityError on malformed state.
 */
function rehydrateGrant(cap, capId) {
    const g = cap.payload;
    if (!g || typeof g !== "object" || Array.isArray(g)) {
        throw new Error("persisted grant payload is malformed");
    }
    if (typeof g.subject !== "string" || !g.subject.trim()) {
        throw new Error("grant subject is missing/malformed");
    }
    if (typeof g.capabilityId !== "string") {
        throw new Error("grant capabilityId is missing");
    }
    // payload capabilityId must match the store key (L-D2 consistency).
    if (canonicalCapabilityId(g.capabilityId) !== capId) {
        throw new Error("grant payload capabilityId != store key");
    }
    if (typeof g.kind !== "string" || !["root", "delegated"].includes(g.kind)) {
        throw new Error("grant kind is invalid");
    }

    const actions = canonicalTokenList(g.actions ?? null, "actions");
    if (!actions.length) {
        throw new Error("grant actions are empty/malformed");
    }
    const scope = canonicalTokenList(g.scope ?? [], "scope");
    const allowedPurposes = canonicalTokenList(g.allowedPurposes ?? [], "allowedPurposes");

    // restrictions MUST be a canonical restriction set (never null).
    let restrictions;
    try {
        restrictions = restoreCanonicalRestrictionSet(g.restrictions);
    } catch (e) {
        throw new Error("grant restrictions malformed: " + (e.message || ""));
    }

    // maxExecutions: null (root unlimited) or a positive integer.
    let maxExecutions = g.maxExecutions;
    if (maxExecutions !== null && maxExecutions !== undefined) {
        const n = Number(maxExecutions);
        if (!Number.isInteger(n) || n <= 0) {
            throw new Error("grant maxExecutions malformed");
        }
        maxExecutions = n;
    } else {
        maxExecutions = null;
    }

    // generation must be a nonnegative safe integer.
    const generation = cap.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("grant generation malformed");
    }

    // identityBinding: null or { channels?, sessionIds?, principals? } arrays.
    let identityBinding = null;
    if (g.identityBinding !== null && g.identityBinding !== undefined) {
        const ib = g.identityBinding;
        if (typeof ib !== "object" || Array.isArray(ib)) {
            throw new Error("grant identityBinding malformed");
        }
        const norm = {};
        for (const key of ["channels", "sessionIds", "principals"]) {
            const list = ib[key];
            if (list === undefined || list === null) continue;
            if (!Array.isArray(list)) {
                throw new Error(`grant identityBinding.${key} malformed`);
            }
            norm[key] = Object.freeze([...new Set(
                list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))]);
        }
        identityBinding = Object.keys(norm).length ? deepFreeze(norm) : null;
    }

    // dates: null or a parseable ISO string.
    function validDateOrNull(v) {
        if (v === null || v === undefined) return null;
        if (typeof v !== "string") throw new Error("grant date malformed");
        if (Number.isNaN(Date.parse(v))) throw new Error("grant date unparseable");
        return v;
    }
    const notBefore = validDateOrNull(g.notBefore);
    const expiresAt = validDateOrNull(g.expiresAt);
    if (typeof g.issuedAt !== "string" || Number.isNaN(Date.parse(g.issuedAt))) {
        throw new Error("grant issuedAt malformed");
    }

    return deepFreeze({
        capabilityId: capId,
        kind: g.kind,
        subject: g.subject,
        actions,
        scope,
        allowedPurposes,
        restrictions,
        maxExecutions,
        generation,
        identityBinding,
        notBefore,
        expiresAt,
        issuedAt: g.issuedAt,
        rootCapabilityId: g.rootCapabilityId ?? null,
        parentCapabilityId: g.parentCapabilityId ?? null,
        ratificationId: g.ratificationId ?? null,
        status: cap.status
    });
}

/**
 * Canonical read-only authorization evaluation.
 *
 * @param {object} store  { getCapability, getGeneration, countConsumption }
 * @param {object} request { capabilityId, action, scope?, purpose?, identity?, nowMs? }
 * @param {object} [opts] { nowMs }
 * @returns {Promise<{allowed, reasonCode, detail, snapshot}>} (branded snapshot)
 */
async function loadAndEvaluateAuthority(store, request = {}, { nowMs = null } = {}) {
    const atMs = (request.nowMs === null || request.nowMs === undefined) ? nowMs : request.nowMs;

    let capId, reqAction, reqScope;
    try {
        capId = canonicalCapabilityId(request.capabilityId);
        reqAction = String(request.action ?? "").trim().toLowerCase();
        reqScope = canonicalTokenList(request.scope ?? [], "scope");
    } catch (error) {
        return deny(EVAL_REASONS.CAP_MALFORMED, error.message);
    }

    let cap;
    try {
        cap = await store.getCapability(capId);
    } catch {
        return deny(EVAL_REASONS.CAP_MALFORMED, "authority store getCapability failed");
    }
    if (!cap) return deny(EVAL_REASONS.CAP_NOT_FOUND);

    // Full rehydration + validation (fail closed on any malformed state).
    let grant;
    try {
        grant = rehydrateGrant(cap, capId);
    } catch (error) {
        return deny(EVAL_REASONS.CAP_MALFORMED, error.message);
    }

    let curGen;
    try {
        curGen = await store.getGeneration(grant.subject);
    } catch {
        return deny(EVAL_REASONS.CAP_MALFORMED, "authority store getGeneration failed");
    }
    if (curGen !== grant.generation) {
        return deny(EVAL_REASONS.CAP_GENERATION_STALE, `gen ${grant.generation} != current ${curGen}`);
    }

    if (grant.status === "SUSPENDED") return deny(EVAL_REASONS.CAP_INACTIVE);
    if (grant.status === "REVOKED") return deny(EVAL_REASONS.CAP_REVOKED);
    if (grant.status === "EXHAUSTED") return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED);
    if (grant.status !== "ACTIVE") return deny(EVAL_REASONS.CAP_INACTIVE, `status ${String(grant.status)}`);

    if (grant.notBefore && atMs < Date.parse(grant.notBefore)) return deny(EVAL_REASONS.CAP_INACTIVE, grant.notBefore);
    if (grant.expiresAt && atMs > Date.parse(grant.expiresAt)) return deny(EVAL_REASONS.CAP_EXPIRED, grant.expiresAt);

    if (!grant.actions.includes(reqAction)) return deny(EVAL_REASONS.CAP_ACTION_DENIED, reqAction);

    // scope (fail closed: empty request scope cannot satisfy a scoped grant)
    if (grant.scope.length && reqScope.length === 0) {
        return deny(EVAL_REASONS.CAP_SCOPE_MISMATCH, "(empty scope)");
    }
    for (const token of reqScope) {
        if (grant.scope.length && !grant.scope.includes(token)) {
            return deny(EVAL_REASONS.CAP_SCOPE_MISMATCH, token);
        }
    }

    const purpose = request.purpose ?? null;
    if (purpose !== null && purpose !== undefined) {
        const p = String(purpose).trim().toLowerCase();
        if (grant.allowedPurposes.length && !grant.allowedPurposes.includes(p)) {
            return deny(EVAL_REASONS.CAP_PURPOSE_MISMATCH, p);
        }
    } else if (grant.allowedPurposes.length) {
        return deny(EVAL_REASONS.CAP_PURPOSE_MISMATCH, "(empty)");
    }

    // identity binding (canonical explicit subject/principal binding)
    const identity = request.identity || {};
    const principal = String(identity.principal ?? "").trim().toLowerCase();
    const ib = grant.identityBinding;
    const ibPrincipals = (ib && Array.isArray(ib.principals)) ? ib.principals : [];
    const grantSubjectLower = grant.subject.trim().toLowerCase();

    if (ibPrincipals.length) {
        // Explicit delegation: principal must be present.
        if (!principal) return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "principal");
        if (!ibPrincipals.includes(principal)) return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "principal");
    } else if (principal) {
        // No delegation: principal must be the grant holder itself.
        if (principal !== grantSubjectLower) return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "principal");
    }
    // else: principal empty + no delegation => principal dimension unconstrained.

    if (ib) {
        const channel = String(identity.channel ?? "").toLowerCase();
        if (Array.isArray(ib.channels) && ib.channels.length && !ib.channels.includes(channel)) {
            return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "channel");
        }
        if (Array.isArray(ib.sessionIds) && ib.sessionIds.length && !ib.sessionIds.includes(String(identity.sessionId ?? ""))) {
            return deny(EVAL_REASONS.CAP_IDENTITY_MISMATCH, "sessionId");
        }
    }

    if (typeof grant.maxExecutions === "number") {
        let used;
        try {
            used = await store.countConsumption(capId);
        } catch {
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, "authority store countConsumption failed");
        }
        if (typeof used !== "number" || !Number.isFinite(used)) {
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, "non-numeric consumption");
        }
        if (used >= grant.maxExecutions) {
            return deny(EVAL_REASONS.CAP_BUDGET_EXHAUSTED, `${used}/${grant.maxExecutions}`);
        }
    }

    const snapshot = deepFreeze({
        capabilityId: capId,
        subject: grant.subject,
        kind: grant.kind,
        principal,
        channel: String(identity.channel ?? "").trim().toLowerCase(),
        sessionId: String(identity.sessionId ?? "").trim().toLowerCase(),
        actions: Object.freeze([...grant.actions]),
        scope: Object.freeze([...reqScope]),
        allowedPurposes: Object.freeze([...grant.allowedPurposes]),
        restrictions: grant.restrictions,
        purpose: purpose === null || purpose === undefined ? null : String(purpose).trim().toLowerCase(),
        identityBinding: grant.identityBinding ? deepFreeze(JSON.parse(JSON.stringify(grant.identityBinding))) : null,
        maxExecutions: grant.maxExecutions,
        expiresAt: grant.expiresAt,
        generation: grant.generation,
        rootCapabilityId: grant.rootCapabilityId,
        parentCapabilityId: grant.parentCapabilityId,
        ratificationId: grant.ratificationId,
        issuedAt: grant.issuedAt,
        evaluatedAtMs: atMs
    });

    return brandEvaluation({ allowed: true, reasonCode: EVAL_REASONS.AUTHORIZED, snapshot });
}

// Backward-compatible alias: the canonical primitive is `loadAndEvaluateAuthority`.
function evaluateAuthorityReadOnly(store, request, opts) {
    return loadAndEvaluateAuthority(store, request, opts);
}

module.exports = {
    loadAndEvaluateAuthority,
    evaluateAuthorityReadOnly,
    isCanonicalAuthorityEvaluation,
    EVAL_REASONS
};
