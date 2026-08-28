"use strict";

/**
 * ACTION AUTHORITY GATE V1 — read-only authority context.
 *
 * This module adapts the EXISTING canonical Authority subsystem's store into a
 * minimal read-only evaluation surface consumed by the ActionAuthorityGate.
 * It does NOT create a second authority system; it reads grants + generations
 * via the same store primitives the AuthorityRegistry.authorize() uses.
 *
 * CRITICAL: this context is READ-ONLY. It never appends audit events, never
 * consumes budget, never mints/revokes/suspends grants. The gate must remain
 * observational over Authority state.
 *
 * The evaluation logic mirrors AuthorityRegistry.authorize()'s grant checks
 * (existence, generation staleness, status, notBefore/expiry, action, scope,
 * purpose, identity binding) but WITHOUT the CAPABILITY_AUTHORIZED audit-event
 * append and WITHOUT budget consumption. It returns a snapshot that binds the
 * decision to the exact grant generation evaluated.
 */

const { canonicalCapabilityId } = require("../capability/registry/ids");

const DECISION_REASONS = Object.freeze({
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

function isActiveStatus(status) {
    return status === "ACTIVE";
}

function includesToken(list, token) {
    return Array.isArray(list) && list.includes(token);
}

/**
 * Build a read-only authority evaluator over an existing Authority store.
 *
 * The store must expose (read-only):
 *   - getCapability(capabilityId) -> { status, generation, payload } | null
 *   - getGeneration(subject)      -> number
 *   - countConsumption(capabilityId) -> number
 *
 * Returns:
 *   evaluate({ capabilityId, action, scope, purpose, identity, nowMs })
 *     -> { allowed, reasonCode, snapshot|null }
 *
 * `snapshot` binds the decision to the evaluated grant generation/version.
 */
function createReadOnlyAuthorityContext(store, { clock = { nowMs: () => Date.now() } } = {}) {
    if (!store || typeof store.getCapability !== "function") {
        throw new TypeError("authority context requires a store with getCapability");
    }

    async function evaluate({ capabilityId, action, scope = [], purpose = null, identity = {}, nowMs = null }) {
        const atMs = (nowMs === null || nowMs === undefined) ? clock.nowMs() : nowMs;

        let capId;
        try {
            capId = canonicalCapabilityId(capabilityId);
        } catch {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_MALFORMED, snapshot: null };
        }

        const reqAction = String(action ?? "").trim().toLowerCase();
        const reqScope = Array.isArray(scope)
            ? [...new Set(scope.map((s) => String(s).trim().toLowerCase()).filter(Boolean))]
            : [];

        let cap;
        try {
            cap = await store.getCapability(capId);
        } catch {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_MALFORMED, snapshot: null };
        }
        if (!cap) return { allowed: false, reasonCode: DECISION_REASONS.CAP_NOT_FOUND, snapshot: null };

        const g = cap.payload;
        if (!g || typeof g !== "object" || Array.isArray(g)) {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_MALFORMED, snapshot: null };
        }

        // Subject binding: the evaluated actor (identity.principal) must be the
        // grant holder. A grant for actor A must never authorize actor B.
        const principal = String(identity.principal ?? "").trim().toLowerCase();
        const grantSubject = String(g.subject ?? "").trim().toLowerCase();
        if (!principal || !grantSubject || principal !== grantSubject) {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_IDENTITY_MISMATCH, snapshot: null };
        }

        let curGen;
        try {
            curGen = await store.getGeneration(g.subject);
        } catch {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_MALFORMED, snapshot: null };
        }
        if (curGen !== cap.generation) {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_GENERATION_STALE, snapshot: null };
        }

        if (cap.status === "SUSPENDED") return { allowed: false, reasonCode: DECISION_REASONS.CAP_INACTIVE, snapshot: null };
        if (cap.status === "REVOKED") return { allowed: false, reasonCode: DECISION_REASONS.CAP_REVOKED, snapshot: null };
        if (cap.status === "EXHAUSTED") return { allowed: false, reasonCode: DECISION_REASONS.CAP_EXHAUSTED, snapshot: null };
        if (cap.status !== "ACTIVE") return { allowed: false, reasonCode: DECISION_REASONS.CAP_INACTIVE, snapshot: null };

        if (g.notBefore && atMs < Date.parse(g.notBefore)) return { allowed: false, reasonCode: DECISION_REASONS.CAP_INACTIVE, snapshot: null };
        if (g.expiresAt && atMs > Date.parse(g.expiresAt)) return { allowed: false, reasonCode: DECISION_REASONS.CAP_EXPIRED, snapshot: null };

        const actions = Array.isArray(g.actions) ? g.actions.map((a) => String(a).trim().toLowerCase()) : [];
        if (!actions.includes(reqAction)) return { allowed: false, reasonCode: DECISION_REASONS.CAP_ACTION_DENIED, snapshot: null };

        const grantScope = Array.isArray(g.scope) ? g.scope.map((s) => String(s).trim().toLowerCase()) : [];
        for (const token of reqScope) {
            if (grantScope.length && !grantScope.includes(token)) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_SCOPE_MISMATCH, snapshot: null };
            }
        }

        const allowedPurposes = Array.isArray(g.allowedPurposes) ? g.allowedPurposes.map((s) => String(s).trim().toLowerCase()) : [];
        if (purpose !== null && purpose !== undefined) {
            const p = String(purpose).trim().toLowerCase();
            if (allowedPurposes.length && !allowedPurposes.includes(p)) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_PURPOSE_MISMATCH, snapshot: null };
            }
        } else if (allowedPurposes.length) {
            return { allowed: false, reasonCode: DECISION_REASONS.CAP_PURPOSE_MISMATCH, snapshot: null };
        }

        const ib = g.identityBinding;
        if (ib && typeof ib === "object") {
            const channel = String(identity.channel ?? "").toLowerCase();
            if (Array.isArray(ib.channels) && ib.channels.length && !ib.channels.includes(channel)) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_IDENTITY_MISMATCH, snapshot: null };
            }
            if (Array.isArray(ib.sessionIds) && ib.sessionIds.length && !ib.sessionIds.includes(String(identity.sessionId ?? ""))) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_IDENTITY_MISMATCH, snapshot: null };
            }
            if (Array.isArray(ib.principals) && ib.principals.length && !ib.principals.includes(String(identity.principal ?? ""))) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_IDENTITY_MISMATCH, snapshot: null };
            }
        }

        if (typeof g.maxExecutions === "number") {
            let used;
            try {
                used = await store.countConsumption(capId);
            } catch {
                used = 0;
            }
            if (used >= g.maxExecutions) {
                return { allowed: false, reasonCode: DECISION_REASONS.CAP_BUDGET_EXHAUSTED, snapshot: null };
            }
        }

        const snapshot = deepFreeze({
            capabilityId: capId,
            subject: g.subject,
            kind: g.kind,
            actions: Object.freeze([...actions]),
            scope: Object.freeze([...reqScope]),
            allowedPurposes: Object.freeze([...allowedPurposes]),
            generation: cap.generation,
            maxExecutions: g.maxExecutions,
            expiresAt: g.expiresAt,
            rootCapabilityId: g.rootCapabilityId,
            parentCapabilityId: g.parentCapabilityId,
            ratificationId: g.ratificationId,
            issuedAt: g.issuedAt,
            evaluatedAtMs: atMs
        });

        return { allowed: true, reasonCode: DECISION_REASONS.AUTHORIZED, snapshot };
    }

    return Object.freeze({ evaluate });
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { createReadOnlyAuthorityContext, DECISION_REASONS, isActiveStatus, includesToken };
