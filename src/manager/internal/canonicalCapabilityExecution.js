"use strict";

/**
 * W8-IW1 — CANONICAL CAPABILITY EXECUTION BRIDGE.
 *
 * The smallest provider-agnostic bridge that turns an AUTHORIZED capability
 * request into an executed, verified, audited effect. It lives under
 * Manager-owned ownership (`src/manager/internal/**`) because that is the
 * canonical ingress owner; it is not a second authority system — it consumes
 * the existing one:
 *
 *   authority      src/authority/evaluate.js  -> isCanonicalAuthorityEvaluation
 *   identity       src/authority/canonical.js -> canonicalCapabilityId
 *   verification   src/core/verify/VerificationEngine.js
 *   audit trail    src/core/safety/auditTrail.js
 *
 * LAWS (each one is a property, not a comment):
 *
 *   CAPABILITY REGISTRATION != AUTHORIZATION
 *   DRIVER PRESENCE         != CAPABILITY PERMISSION
 *   TOOL RESULT             != VERIFIED RESULT
 *   ARBITRARY ASYNC RETURN  != AUDIT ACKNOWLEDGEMENT
 *   CALLER FUNCTION REF     != EXECUTION AUTHORITY
 *   MODEL-SELECTED HANDLER  != AUTHORITY
 *
 * Coverage of the Phase 3A requirements:
 *   (1)  Manager-owned module, reachable only through composition.
 *   (2)  accepts a capability request + canonical authority evaluation, never
 *        an arbitrary tool call.
 *   (3)  exact canonical capability id (canonicalCapabilityId).
 *   (4)  exact operation binding (capabilityId+operation -> one driver).
 *   (5)  exact parameters digest binding (requestDigest).
 *   (6)  exact principal/scope binding (both are part of the digest and are
 *        passed to the driver).
 *   (7)(8)(9)  no executable reference in caller input: parameters are
 *        validated inert, callables/Proxies/symbols are refused.
 *   (10) the capability registry is used for identity/metadata, never for
 *        authority; a registered capability still needs an authorization.
 *   (11) the driver is resolved only AFTER authorization passes.
 *   (12) VerificationEngine decides whether the result may be published.
 *   (13) auditTrail records the intent and the completion.
 *   (14) audit acknowledgement failure cannot yield success.
 *   (15) verification failure cannot yield success.
 *   (16) a consumed request digest can never invoke a driver twice.
 *   (17) results use the canonical outcome vocabulary below.
 *   (18) thenables/promises are never treated as audit authority.
 *   (19) unsupported/hostile result shapes fail closed.
 *   (20) the driver table is closure-private; there is no exported resolver.
 */

const crypto = require("node:crypto");
const utilTypes = require("node:util").types;

const { canonicalCapabilityId } = require("../../authority/canonical");
const { isCanonicalAuthorityEvaluation } = require("../../authority/evaluate");
const VerificationEngine = require("../../core/verify/VerificationEngine");
const auditTrail = require("../../core/safety/auditTrail");

/** Canonical outcomes. Only EXECUTED_VERIFIED is a completed success. */
const OUTCOME = Object.freeze({
    EXECUTED_VERIFIED: "EXECUTED_VERIFIED",
    DENIED: "DENIED",
    REFUSED: "REFUSED",
    FAILED: "FAILED",
    UNKNOWN: "UNKNOWN",
    UNVERIFIED: "UNVERIFIED",
    CANCELLED_BEFORE_EFFECT: "CANCELLED_BEFORE_EFFECT",
    AMBIGUOUS_AFTER_INVOCATION: "AMBIGUOUS_AFTER_INVOCATION"
});

/** Reasons a request can be refused before any driver is resolved. */
const REFUSAL = Object.freeze({
    MALFORMED_REQUEST: "MALFORMED_REQUEST",
    NON_INERT_REQUEST: "NON_INERT_REQUEST",
    CAPABILITY_MALFORMED: "CAPABILITY_MALFORMED",
    CAPABILITY_UNBOUND: "CAPABILITY_UNBOUND",
    OPERATION_UNBOUND: "OPERATION_UNBOUND",
    AUTHORITY_MISSING: "AUTHORITY_MISSING",
    AUTHORITY_FORGED: "AUTHORITY_FORGED",
    AUTHORITY_MISMATCH: "AUTHORITY_MISMATCH",
    REPLAY: "REPLAY",
    CALLER_SELECTED_HANDLER: "CALLER_SELECTED_HANDLER"
});

/** Brand gate: only results produced by this bridge count as canonical. */
const resultGate = new WeakSet();

/** Closure-private driver/verifier/consumption state, per bridge instance. */
const STATE = new WeakMap();

function brand(result) {
    resultGate.add(result);
    return Object.freeze(result);
}

function isCanonicalCapabilityResult(value) {
    return value !== null && typeof value === "object" && resultGate.has(value);
}

function state(instance) {
    const s = STATE.get(instance);
    if (!s) throw new Error("canonical execution bridge is not composed");
    return s;
}

function isPlainObject(v) {
    if (v === null || typeof v !== "object") return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/**
 * Inert-data check for caller-supplied parameters. A function reference, a
 * Proxy, a symbol value or an exotic object is NOT data; it is a code path, so
 * it is refused before any driver is resolved.
 */
function inertnessProblem(value, depth = 0, seen = new Set()) {
    if (depth > 12) return "too deeply nested";
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return null;
    if (t === "function") return "function reference";
    if (t === "symbol") return "symbol value";
    if (t !== "object") return "unsupported value";
    if (utilTypes.isProxy(value)) return "proxy";
    if (seen.has(value)) return "cycle";
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const problem = inertnessProblem(item, depth + 1, seen);
            if (problem) return problem;
        }
        return null;
    }
    if (value instanceof Date) return null;
    if (!isPlainObject(value)) return "non-plain object";
    let keys;
    try {
        keys = Object.keys(value);
    }
    catch {
        return "unreadable properties";
    }
    for (const key of keys) {
        let item;
        try {
            item = value[key];
        }
        catch {
            return "hostile property";
        }
        const problem = inertnessProblem(item, depth + 1, seen);
        if (problem) return problem;
    }
    return null;
}

function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

class CanonicalCapabilityExecution {

    constructor() {
        STATE.set(this, {
            drivers: new Map(),        // "<capabilityId>|<operation>" -> registration
            verifiers: new Map(),      // capabilityId -> verifier
            consumed: new Map(),       // requestDigest -> outcome token
            acknowledger: null,
            clock: () => Date.now()
        });
    }

    /**
     * Trusted, composition-time driver registration. Registration is NOT
     * authorization: a registered capability still needs a canonical authority
     * evaluation, and driver presence never implies permission.
     */
    registerCapability({ capabilityId, operation, driver, driverId = null, consequential = true } = {}) {

        const id = canonicalCapabilityId(capabilityId);
        if (typeof operation !== "string" || operation.trim() === "") {
            throw new TypeError("operation must be a non-empty string");
        }
        if (typeof driver !== "function") {
            throw new TypeError("driver must be a function supplied at composition time");
        }

        const key = `${id}|${operation}`;
        const s = state(this);
        if (s.drivers.has(key)) {
            throw new Error(`capability already registered: ${key}`);
        }
        s.drivers.set(key, Object.freeze({
            capabilityId: id,
            operation,
            driver,
            driverId: driverId ?? id,
            consequential: consequential === true
        }));
        return id;
    }

    /** Trusted, composition-time verifier registration for a capability. */
    registerVerifier(capabilityId, verifier) {
        if (typeof verifier !== "function") {
            throw new TypeError("verifier must be a function supplied at composition time");
        }
        const id = canonicalCapabilityId(capabilityId);
        STATE.get(this).verifiers.set(id, verifier);
        return id;
    }

    /**
     * Trusted audit acknowledgement port. `auditTrail.record` deliberately
     * swallows failures and returns nothing, so it can never be an
     * acknowledgement: without a real acknowledger this bridge refuses to
     * publish canonical completion.
     */
    installAuditAcknowledger(acknowledger) {
        if (typeof acknowledger !== "function") {
            throw new TypeError("acknowledger must be a function");
        }
        state(this).acknowledger = acknowledger;
        return true;
    }

    /** Deterministic request digest: binds capability, operation, parameters,
     *  principal and scope into one value. */
    requestDigest({ capabilityId, operation, parameters = null, principal = null, scope = null } = {}) {
        const material = canonicalJson({
            capabilityId: canonicalCapabilityId(capabilityId),
            operation,
            parameters,
            principal,
            scope
        });
        return crypto.createHash("sha256").update(material).digest("hex");
    }

    /**
     * Execute an authorized capability request.
     *
     * @param {object} request
     * @param {string} request.capabilityId
     * @param {string} request.operation
     * @param {*}      request.parameters  inert data only
     * @param {*}      request.evaluation  branded canonical authority evaluation
     * @param {*}      [request.signal]    AbortSignal for cancellation
     * @param {string} [request.requestId]
     */
    async execute(request) {

        if (request === null || typeof request !== "object" || utilTypes.isProxy(request)) {
            return brand({ outcome: OUTCOME.REFUSED, reason: REFUSAL.MALFORMED_REQUEST, effectInvoked: false });
        }

        let capabilityId;
        try {
            capabilityId = canonicalCapabilityId(request.capabilityId);
        }
        catch {
            return brand({ outcome: OUTCOME.REFUSED, reason: REFUSAL.CAPABILITY_MALFORMED, effectInvoked: false });
        }

        const operation = typeof request.operation === "string" ? request.operation.trim() : "";
        if (operation === "") {
            return brand({ outcome: OUTCOME.REFUSED, reason: REFUSAL.MALFORMED_REQUEST, effectInvoked: false });
        }

        const problem = inertnessProblem(request.parameters ?? null);
        if (problem) {
            return brand({
                outcome: OUTCOME.REFUSED,
                reason: REFUSAL.NON_INERT_REQUEST,
                detail: problem,
                effectInvoked: false
            });
        }

        const s = state(this);

        // ---- AUTHORIZATION (before any driver is resolved) -----------------
        const evaluation = request.evaluation;
        if (evaluation === undefined || evaluation === null) {
            return brand({ outcome: OUTCOME.DENIED, reason: REFUSAL.AUTHORITY_MISSING, effectInvoked: false });
        }
        // BRAND-FIRST: no property read on an unbranded value.
        if (!isCanonicalAuthorityEvaluation(evaluation)) {
            return brand({ outcome: OUTCOME.DENIED, reason: REFUSAL.AUTHORITY_FORGED, effectInvoked: false });
        }
        if (evaluation.snapshot.capabilityId !== capabilityId) {
            return brand({ outcome: OUTCOME.DENIED, reason: REFUSAL.AUTHORITY_MISMATCH, effectInvoked: false });
        }

        const binding = s.drivers.get(`${capabilityId}|${operation}`);
        if (!binding) {
            return brand({ outcome: OUTCOME.REFUSED, reason: REFUSAL.CAPABILITY_UNBOUND, effectInvoked: false });
        }

        const digest = this.requestDigest({
            capabilityId,
            operation,
            parameters: request.parameters ?? null,
            principal: evaluation.snapshot.principal ?? null,
            scope: evaluation.snapshot.scope ?? null
        });

        // ---- EXACT-ONCE (before the effect, so a replay cannot reapply it) --
        if (s.consumed.has(digest)) {
            return brand({
                outcome: OUTCOME.REFUSED,
                reason: REFUSAL.REPLAY,
                priorOutcome: s.consumed.get(digest),
                effectInvoked: false
            });
        }

        // ---- CANCELLATION BEFORE INVOCATION --------------------------------
        if (request.signal && request.signal.aborted === true) {
            s.consumed.set(digest, OUTCOME.CANCELLED_BEFORE_EFFECT);
            return brand({ outcome: OUTCOME.CANCELLED_BEFORE_EFFECT, reason: "ABORTED_BEFORE_INVOCATION", effectInvoked: false });
        }

        const requestId = typeof request.requestId === "string" ? request.requestId : digest.slice(0, 16);

        this._audit({
            tool: capabilityId,
            risk: binding.consequential ? "destructive" : "safe",
            outcome: "allowed",
            requestId,
            operation
        });

        // ---- INVOKE (the driver has been resolved only now) ----------------
        let raw;
        let threw = null;
        try {
            raw = await binding.driver({
                parameters: request.parameters ?? null,
                principal: evaluation.snapshot.principal ?? null,
                scope: evaluation.snapshot.scope ?? null,
                requestId,
                signal: request.signal ?? null
            });
        }
        catch (error) {
            threw = error;
        }

        const invoked = true;

        if (threw !== null) {
            const outcome = request.signal && request.signal.aborted === true
                ? OUTCOME.AMBIGUOUS_AFTER_INVOCATION
                : OUTCOME.FAILED;
            s.consumed.set(digest, outcome);
            this._audit({ tool: capabilityId, risk: "destructive", outcome: "error", requestId, operation });
            return brand({
                outcome,
                reason: "DRIVER_THREW",
                effectInvoked: invoked,
                error: threw instanceof Error ? threw.message : "non-error throw"
            });
        }

        // ---- RESULT SHAPE (hostile/malformed fails closed) -----------------
        const shapeProblem = this._resultShapeProblem(raw);
        if (shapeProblem) {
            s.consumed.set(digest, OUTCOME.UNVERIFIED);
            this._audit({ tool: capabilityId, risk: "destructive", outcome: "error", requestId, operation });
            return brand({
                outcome: OUTCOME.UNVERIFIED,
                reason: `MALFORMED_RESULT:${shapeProblem}`,
                effectInvoked: invoked
            });
        }

        // ---- VERIFICATION (before success publication) ---------------------
        const verification = await this._verify(capabilityId, request.parameters ?? null, raw);

        if (verification.state !== "verified" &&
            !(verification.state === "skipped" && binding.consequential === false)) {
            s.consumed.set(digest, OUTCOME.UNVERIFIED);
            this._audit({ tool: capabilityId, risk: "destructive", outcome: "error", requestId, operation });
            return brand({
                outcome: OUTCOME.UNVERIFIED,
                reason: `VERIFICATION_${String(verification.state).toUpperCase()}`,
                effectInvoked: invoked,
                verification
            });
        }

        // Cancellation requested after invocation is NOT a claim of prevention:
        // the effect happened, so the honest answer stays ambiguous unless the
        // verifier already proved the world changed.
        if (request.signal && request.signal.aborted === true) {
            s.consumed.set(digest, OUTCOME.AMBIGUOUS_AFTER_INVOCATION);
            this._audit({ tool: capabilityId, risk: "destructive", outcome: "error", requestId, operation });
            return brand({
                outcome: OUTCOME.AMBIGUOUS_AFTER_INVOCATION,
                reason: "ABORTED_AFTER_INVOCATION",
                effectInvoked: invoked,
                verification
            });
        }

        // ---- AUDIT ACKNOWLEDGEMENT (failure cannot yield success) ----------
        const ack = this._acknowledge({
            capabilityId,
            operation,
            requestId,
            requestDigest: digest,
            principal: evaluation.snapshot.principal ?? null,
            scope: evaluation.snapshot.scope ?? null,
            authorityGeneration: evaluation.snapshot.generation ?? null,
            verificationState: verification.state
        });

        if (ack.ok !== true) {
            s.consumed.set(digest, OUTCOME.UNVERIFIED);
            this._audit({ tool: capabilityId, risk: "destructive", outcome: "error", requestId, operation });
            return brand({
                outcome: OUTCOME.UNVERIFIED,
                reason: "AUDIT_NOT_ACKNOWLEDGED",
                effectInvoked: invoked,
                verification
            });
        }

        this._audit({ tool: capabilityId, risk: "destructive", outcome: "ok", requestId, operation });
        s.consumed.set(digest, OUTCOME.EXECUTED_VERIFIED);

        return brand({
            outcome: OUTCOME.EXECUTED_VERIFIED,
            reason: "AUTHORIZED_AND_VERIFIED",
            effectInvoked: invoked,
            driverId: binding.driverId,
            // The raw driver output is carried ONLY on a verified completion, so a
            // caller can never mistake an unverified effect for a result.
            result: raw,
            verification,
            receipt: ack.receipt
        });
    }

    /** Result shape check. A caller-visible function, Proxy or exotic object is
     *  not a result; it is code. */
    _resultShapeProblem(value) {
        if (value === undefined) return "undefined result";
        if (value === null) return null;
        const t = typeof value;
        if (t === "function") return "callable result";
        if (t === "symbol") return "symbol result";
        if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return null;
        if (t !== "object") return "unsupported result";
        if (utilTypes.isProxy(value)) return "proxy result";
        if (Array.isArray(value)) return null;
        if (!isPlainObject(value) && !(value instanceof Date)) return "non-plain result";
        return null;
    }

    async _verify(capabilityId, parameters, result) {
        const verifier = state(this).verifiers.get(capabilityId);
        if (verifier) {
            try {
                const out = await verifier(parameters, result);
                const checks = Array.isArray(out?.checks) ? out.checks : [];
                const allPassed = checks.length > 0 && checks.every(c => c.passed === true);
                return {
                    tool: capabilityId,
                    state: allPassed ? "verified" : (checks.length === 0 ? "unverified" : "failed"),
                    checks,
                    passed: checks.filter(c => c.passed).length,
                    total: checks.length
                };
            }
            catch {
                return { tool: capabilityId, state: "unverified", checks: [], passed: 0, total: 0 };
            }
        }
        try {
            return await VerificationEngine.verify(capabilityId, parameters, result);
        }
        catch {
            return { tool: capabilityId, state: "unverified", checks: [], passed: 0, total: 0 };
        }
    }

    /** Audit acknowledgement. A promise/thenable is never an acknowledgement:
     *  ack must be a synchronous value with ok === true. */
    _acknowledge(entry) {
        const acknowledger = state(this).acknowledger;
        if (typeof acknowledger !== "function") {
            return { ok: false, receipt: null, reason: "NO_ACKNOWLEDGER" };
        }
        let ack;
        try {
            ack = acknowledger(entry);
        }
        catch {
            return { ok: false, receipt: null, reason: "ACKNOWLEDGER_THREW" };
        }
        if (ack !== null && typeof ack === "object" && typeof ack.then === "function") {
            return { ok: false, receipt: null, reason: "ASYNC_ACK_NOT_ACCEPTED" };
        }
        if (!isPlainObject(ack) || ack.ok !== true) {
            return { ok: false, receipt: null, reason: "ACK_NOT_ACKNOWLEDGED" };
        }
        return { ok: true, receipt: typeof ack.receipt === "string" ? ack.receipt : null };
    }

    _audit(entry) {
        try {
            auditTrail.record(entry);
        }
        catch { /* the durable trail is best-effort; the ack port is the gate */ }
    }
}

module.exports = {
    CanonicalCapabilityExecution,
    OUTCOME,
    REFUSAL,
    isCanonicalCapabilityResult
};
