"use strict";

// Canonical Approval Domain owner (DP-L1..L3).
//
// DOMAIN LAW (DP §6): APPROVAL != AUTHORITY, APPROVED != EXECUTED. This domain
// owns the human-decision lifecycle ONLY. It is NOT an authority source, NOT an
// execution owner, NOT a notification owner. AUTHORITY_SOURCE_COUNT stays 1:
// the single producer remains loadAndEvaluateAuthority behind the canonical
// Gate. An APPROVE decision is translated into frozen-HC confirmation evidence
// through the sealed Owner-trust composition, and the canonical Gate RE-EVALUATES
// every hard constraint before any ALLOW. There is no APPROVED -> ALLOW and no
// APPROVED -> execute path here.

const crypto = require("node:crypto");
const { makeApprovalStore } = require("./store");
const { withSharedLock } = require("../canonical/kvIndex");

const STATE = Object.freeze({
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    DENIED: "DENIED",
    EXPIRED: "EXPIRED",
    STALE: "STALE",
    CANCELLED: "CANCELLED",
    SUPERSEDED: "SUPERSEDED"
});

// Only PENDING is non-terminal (DP §15, §19). Every edge leaves PENDING exactly
// once; a resolved approval never silently returns to PENDING and a late
// conflicting decision never rewrites the canonical resolution.
const TERMINAL = Object.freeze(new Set([
    STATE.APPROVED, STATE.DENIED, STATE.EXPIRED, STATE.STALE, STATE.CANCELLED, STATE.SUPERSEDED
]));

const TRANSITIONS = Object.freeze({
    PENDING: Object.freeze([STATE.APPROVED, STATE.DENIED, STATE.EXPIRED, STATE.STALE, STATE.CANCELLED, STATE.SUPERSEDED]),
    APPROVED: Object.freeze([]), DENIED: Object.freeze([]), EXPIRED: Object.freeze([]),
    STALE: Object.freeze([]), CANCELLED: Object.freeze([]), SUPERSEDED: Object.freeze([])
});

const DECISION_STATE = Object.freeze({ APPROVE: STATE.APPROVED, DENY: STATE.DENIED });

const REASON = Object.freeze({
    UNKNOWN_APPROVAL: "UNKNOWN_APPROVAL",
    ALREADY_RESOLVED: "ALREADY_RESOLVED",
    STALE_REVISION: "STALE_REVISION",
    UNKNOWN_DECISION: "UNKNOWN_DECISION",
    PROOF_REQUIRED: "PROOF_REQUIRED",
    CONFIRMATION_REJECTED: "CONFIRMATION_REJECTED",
    NOT_SUSPENDED: "NOT_SUSPENDED",
    NOT_CANONICAL_REQUIREMENT: "NOT_CANONICAL_REQUIREMENT",
    BRIDGE_UNAVAILABLE: "BRIDGE_UNAVAILABLE"
});

class ApprovalError extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = "ApprovalError";
        this.code = code;
        this.detail = detail ?? null;
    }
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function createApprovalDomain({
    store,
    acc,
    ownerTrust = null,
    manager = null,
    clock = () => Date.now(),
    audit = null,
    retentionMs = DEFAULT_RETENTION_MS,
    idFactory = () => `apr-${crypto.randomUUID()}`
} = {}) {
    const backing = store || (acc ? makeApprovalStore(acc) : null);
    if (!backing) throw new TypeError("approval domain requires { store } or { acc }");
    const { isCanonicalConfirmationRequirement } = require("../authority/evaluate");

    // PROCESS-LOCAL live binding to frozen HC. Holds the branded requirement and
    // the opaque continuation token. This map is intentionally NOT persisted:
    // it mirrors HC's PROCESS_LOCAL_NON_DURABLE suspension. After a restart it is
    // empty, so a durable PENDING record has no live HC continuation and is
    // reconciled fail-closed (DP §32, §35, AR2/AR3).
    const liveBindings = new Map();
    // Storage-scoped locks (src/canonical/kvIndex): shared by every domain instance
    // in the process, so two surfaces cannot race the same approval or requirement.
    const withLock = withSharedLock;
    const recKey = (approvalId) => `approval:rec:${approvalId}`;

    function emit(eventType, rec, outcome) {
        if (!audit || typeof audit.append !== "function") return;
        try {
            audit.append({
                eventType,
                source: "canonical.approval",
                actor: { kind: "system", id: "approval-domain" },
                subject: { kind: "service", id: "approval" },
                operation: eventType,
                outcome,
                correlation: { sessionId: rec.session_id || undefined, correlationId: rec.continuation_ref || undefined },
                metadata: { approval_id: rec.approval_id, requirement_ref: rec.requirement_ref, state: rec.state, authority_result: rec.authority_result }
            });
        } catch { /* Audit is correlation only (DP §29); it is never the state owner and never throws into the domain. */ }
    }

    // Surface-safe read model (DP §27, §28). No principal, no intent arguments,
    // no confirmation evidence, no owner proof, no raw secrets. Authority-internal
    // digests (intent/grant revision) are deliberately omitted from the surface.
    function surfaceRecord(rec) {
        return Object.freeze({
            approval_id: rec.approval_id,
            confirmation_requirement_ref: rec.requirement_ref,
            state: rec.state,
            authority_result: rec.authority_result,
            verification_result: rec.verification_result,
            capability_ref: rec.capability_id,
            scope: rec.scope ?? null,
            purpose: rec.purpose ?? null,
            risk: rec.risk ?? null,
            effect: rec.effect ?? null,
            source_ref: rec.source_ref ?? null,
            created_at: rec.created_at,
            expires_at: rec.expires_at,
            decision_at: rec.decision_at,
            revision: rec.revision,
            stale_reason: rec.stale_reason ?? null,
            source: "canonical_approval_read_model"
        });
    }

    function bridgeResult(mr) {
        const allowed = Boolean(mr && mr.authorityEvidence && mr.authorityEvidence.decision === "ALLOW");
        return Object.freeze({
            authority_result: allowed ? "ALLOW" : "DENY",
            verification_result: mr ? (mr.outcome ?? "UNKNOWN") : "UNKNOWN",
            execution_id: mr ? (mr.executionId ?? null) : null,
            manager_outcome: mr ? (mr.outcome ?? null) : null,
            detail: mr ? (mr.detail ?? null) : null
        });
    }

    async function terminalize(rec, target, { stale_reason = null, idempotencyKey = null } = {}) {
        rec.state = target;
        rec.revision += 1;
        rec.stale_reason = stale_reason;
        if (idempotencyKey) rec.last_idempotency_key = idempotencyKey;
        liveBindings.delete(rec.approval_id);
        await backing.put(rec);
        emit(`approval.${target.toLowerCase()}`, rec, target === STATE.APPROVED ? "ok" : "denied");
        return surfaceRecord(rec);
    }

    // DP §11/§12: an approval may be created ONLY from a valid canonical HC
    // confirmation requirement, delivered as a frozen-HC SUSPENDED Manager
    // result. No surface, model, caller flag, tool name or risk score can mint
    // one. Identity is stable: a second call for the same requirement returns
    // the same approval (DP §13, A2, A22).
    async function createFromSuspension(managerResult, { sourceRef = null, risk = null, effect = null } = {}) {
        if (!managerResult || managerResult.lifecycleState !== "SUSPENDED" ||
            managerResult.outcome !== "OWNER_CONFIRMATION_REQUIRED") {
            throw new ApprovalError(REASON.NOT_SUSPENDED, "a canonical SUSPENDED/OWNER_CONFIRMATION_REQUIRED Manager result is required");
        }
        const requirement = managerResult.confirmationRequirement;
        if (!isCanonicalConfirmationRequirement(requirement)) {
            throw new ApprovalError(REASON.NOT_CANONICAL_REQUIREMENT, "confirmation requirement is not canonically branded");
        }
        return withLock(`approval:req:${requirement.requirementId}`, () => createOrReuse(managerResult, requirement, { sourceRef, risk, effect }));
    }

    async function createOrReuse(managerResult, requirement, { sourceRef, risk, effect }) {
        const existing = await backing.byRequirement(requirement.requirementId);
        if (existing) {
            if (!liveBindings.has(existing.approval_id)) {
                liveBindings.set(existing.approval_id, {
                    requirement, continuationId: managerResult.continuationId,
                    principal: requirement.principal, sessionId: requirement.sessionId, channel: requirement.channel
                });
            }
            return surfaceRecord(existing);
        }
        const approval_id = idFactory();
        const now = clock();
        const rec = {
            approval_id,
            requirement_ref: requirement.requirementId,
            continuation_ref: managerResult.continuationId,
            intent_id: requirement.intentId,
            intent_revision: requirement.intentRevision,
            capability_id: requirement.capabilityId,
            grant_revision: requirement.grantRevision,
            policy_id: requirement.policyId,
            policy_revision: requirement.policyRevision,
            principal: requirement.principal,
            channel: requirement.channel,
            session_id: requirement.sessionId,
            scope: requirement.scope ?? null,
            purpose: requirement.purpose ?? null,
            state: STATE.PENDING,
            revision: 1,
            created_at: now,
            expires_at: requirement.expiresAtMs,
            decision_at: null,
            decided_by: null,
            authority_result: "PENDING",
            verification_result: "UNKNOWN",
            source_ref: sourceRef,
            risk, effect,
            stale_reason: null,
            last_idempotency_key: null
        };
        liveBindings.set(approval_id, {
            requirement, continuationId: managerResult.continuationId,
            principal: requirement.principal, sessionId: requirement.sessionId, channel: requirement.channel
        });
        await backing.create(rec);
        emit("approval.created", rec, "ok");
        return surfaceRecord(rec);
    }

    // DP §20-§24: the canonical decision command. expectedRevision is the
    // optimistic stale guard; actor is provenance; authenticationEvidence and
    // confirmationProof are the Owner's live cryptographic material carried
    // through to frozen HC. DP itself verifies none of it — the sealed trust
    // composition and the Gate do.
    async function decide({ approvalId, decision, expectedRevision = null, actor = null,
        authenticationEvidence = null, confirmationProof = null, idempotencyKey = null } = {}) {
        return withLock(recKey(approvalId), async () => {
            const rec = await backing.get(approvalId);
            if (!rec) throw new ApprovalError(REASON.UNKNOWN_APPROVAL, approvalId);

            if (TERMINAL.has(rec.state)) {
                // Idempotent replay: same decision (or same idempotency key) returns
                // the recorded canonical resolution. A conflicting later decision
                // cannot rewrite it (DP §19, §38).
                if (rec.state === DECISION_STATE[decision] ||
                    (idempotencyKey && rec.last_idempotency_key === idempotencyKey)) {
                    return { approval: surfaceRecord(rec), bridge: rec.bridge ?? null, idempotent: true };
                }
                throw new ApprovalError(REASON.ALREADY_RESOLVED, rec.state);
            }
            if (expectedRevision !== null && expectedRevision !== rec.revision) {
                throw new ApprovalError(REASON.STALE_REVISION, `expected ${expectedRevision} got ${rec.revision}`);
            }

            const now = clock();
            if (now >= rec.expires_at) {
                return { approval: await terminalize(rec, STATE.EXPIRED, { stale_reason: "REQUIREMENT_WINDOW_ELAPSED" }), bridge: null, idempotent: false };
            }
            const binding = liveBindings.get(approvalId);
            if (!binding) {
                // Durable record outlived its process-local HC continuation (restart /
                // orphaned requirement). FAIL CLOSED: no execution, no fabricated
                // continuation (DP §32, §33, §35, AR3).
                return { approval: await terminalize(rec, STATE.STALE, { stale_reason: "ORPHANED_REQUIREMENT_NO_LIVE_HC_CONTINUATION" }), bridge: null, idempotent: false };
            }

            if (decision === "DENY") {
                // DENY mints no positive evidence and triggers no execution (DP §17, §24).
                rec.decision_at = now;
                rec.decided_by = actor;
                return { approval: await terminalize(rec, STATE.DENIED, { idempotencyKey }), bridge: null, idempotent: false };
            }

            if (decision === "APPROVE") {
                if (!ownerTrust || !ownerTrust.humanConfirmation || !manager || typeof manager.resumeConfirmation !== "function") {
                    throw new ApprovalError(REASON.BRIDGE_UNAVAILABLE, "APPROVE requires the sealed HC composition and the canonical Manager");
                }
                if (!confirmationProof) throw new ApprovalError(REASON.PROOF_REQUIRED, "a live Owner confirmation proof is required to approve");

                // Translate the human decision into frozen-HC confirmation evidence.
                // The sealed composition is single-use per requirement and verifies the
                // Owner proof; DP mints nothing itself (DP §23, §25).
                const evidence = ownerTrust.humanConfirmation.confirm({ requirement: binding.requirement, proof: confirmationProof });
                if (!evidence) {
                    if (clock() >= rec.expires_at) {
                        return { approval: await terminalize(rec, STATE.EXPIRED, { stale_reason: "REQUIREMENT_WINDOW_ELAPSED" }), bridge: null, idempotent: false };
                    }
                    // Requirement still live => the proof was invalid or already spent.
                    // The approval stays PENDING so a valid proof can still be presented.
                    throw new ApprovalError(REASON.CONFIRMATION_REJECTED, "Owner confirmation proof rejected by the sealed trust composition");
                }

                // Record APPROVED first. This means ONLY that a valid human decision was
                // recorded — NOT that the Gate allowed, NOT that execution occurred
                // (DP §16). authority_result is populated by the separate re-evaluation.
                rec.state = STATE.APPROVED;
                rec.decision_at = now;
                rec.decided_by = actor;
                rec.revision += 1;
                if (idempotencyKey) rec.last_idempotency_key = idempotencyKey;
                await backing.put(rec);
                emit("approval.decision.accepted", rec, "ok");

                // BRIDGE: hand the evidence to the Manager continuation, which re-enters
                // the canonical Gate. Only a FRESH ALLOW there reaches execution; DP
                // never short-circuits it (DP §23). The continuation and the evidence
                // are both single-use, so a double decision cannot double-execute.
                // A1: a bridge/continuation exception is NOT a Gate decision. The Gate
                // did not necessarily return DENY, so the record says NOT_EVALUATED with
                // BRIDGE_FAILED. The human APPROVED decision above stays as recorded
                // (DP §16). Fail closed: no ALLOW, no execution, no automatic retry
                // (evidence and continuation are single-use).
                let bridge;
                let bridgeFailed = false;
                try {
                    const mr = await manager.resumeConfirmation({
                        continuationId: binding.continuationId,
                        authenticationEvidence,
                        confirmationEvidence: evidence
                    });
                    bridge = bridgeResult(mr);
                } catch (e) {
                    bridgeFailed = true;
                    bridge = Object.freeze({
                        authority_result: "NOT_EVALUATED",
                        verification_result: "BRIDGE_FAILED",
                        execution_id: null,
                        manager_outcome: "BRIDGE_FAILED",
                        continuation_outcome: "CONTINUATION_FAILED",
                        detail: String((e && (e.reasonCode || e.message)) || "continuation failed").slice(0, 256)
                    });
                }
                rec.authority_result = bridge.authority_result;
                rec.verification_result = bridge.verification_result;
                rec.bridge = bridge;
                liveBindings.delete(approvalId); // evidence consumed; no second re-evaluation (AR7)
                await backing.put(rec);
                emit(bridgeFailed ? "approval.bridge.failed" : "approval.authority.reevaluated",
                    rec, bridge.authority_result === "ALLOW" ? "ok" : "denied");
                return { approval: surfaceRecord(rec), bridge, idempotent: false };
            }

            // Unknown decisions fail closed (DP §21).
            throw new ApprovalError(REASON.UNKNOWN_DECISION, String(decision));
        });
    }

    function sourceTerminator(target) {
        return (approvalId, reason = null) => withLock(recKey(approvalId), async () => {
            const rec = await backing.get(approvalId);
            if (!rec) throw new ApprovalError(REASON.UNKNOWN_APPROVAL, approvalId);
            if (TERMINAL.has(rec.state)) return surfaceRecord(rec);
            return terminalize(rec, target, { stale_reason: reason });
        });
    }

    // Restart / source-change reconciliation (DP §32, §34, AR1-AR3). Expired or
    // orphaned PENDING records move to a truthful terminal state; a still-live
    // PENDING record is left untouched.
    async function reconcile(approvalId) {
        return withLock(recKey(approvalId), async () => {
            const rec = await backing.get(approvalId);
            if (!rec) throw new ApprovalError(REASON.UNKNOWN_APPROVAL, approvalId);
            if (TERMINAL.has(rec.state)) return surfaceRecord(rec);
            if (clock() >= rec.expires_at) return terminalize(rec, STATE.EXPIRED, { stale_reason: "REQUIREMENT_WINDOW_ELAPSED" });
            if (!liveBindings.has(approvalId)) return terminalize(rec, STATE.STALE, { stale_reason: "ORPHANED_REQUIREMENT_NO_LIVE_HC_CONTINUATION" });
            return surfaceRecord(rec);
        });
    }

    return Object.freeze({
        STATE, TERMINAL, TRANSITIONS, REASON, ApprovalError,
        createFromSuspension,
        decide,
        cancel: sourceTerminator(STATE.CANCELLED),
        supersede: sourceTerminator(STATE.SUPERSEDED),
        markStale: (id, reason = "HC_BINDING_INVALIDATED") => sourceTerminator(STATE.STALE)(id, reason),
        reconcile,
        async get(approvalId) { const r = await backing.get(approvalId); return r ? surfaceRecord(r) : null; },
        // Bounded, newest-first discovery. Default and maximum page sizes are finite.
        async list({ state = null, limit = DEFAULT_LIST_LIMIT } = {}) {
            const cap = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
            const recs = await backing.list({ limit: cap, predicate: (r) => !state || r.state === state });
            return recs.map(surfaceRecord);
        },
        // Retention (DP-R6): removes TERMINAL approvals whose requirement window
        // elapsed more than retentionMs ago. PENDING approvals never move. A removed
        // approval id is unknown afterwards, so its decision cannot be re-applied.
        async compact() {
            const horizon = clock() - retentionMs;
            return withLock("approval:index-retention", () => backing.compact({
                removable: (r) => TERMINAL.has(r.state) && r.expires_at < horizon
            }));
        }
    });
}

module.exports = { createApprovalDomain, STATE, TERMINAL, TRANSITIONS, REASON, ApprovalError };
