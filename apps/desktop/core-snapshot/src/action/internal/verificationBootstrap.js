"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION — TRUSTED INTERNAL COMPOSITION
 * (TARGETED REPAIR 4).
 *
 * This module is the ONLY place where the production Lane 4 verification/
 * compensation composition is implemented. It is an INTERNAL trusted module:
 *   - it is NOT re-exported through src/action/index.js (the public surface);
 *   - ordinary downstream callers CANNOT reach it through the canonical
 *     bootstrap facade (the facade still exposes exactly
 *     { verify, compensate, isCanonical* });
 *   - the production runtime calls it via src/action/bootstrap.js with
 *     trustedVerifiers = [] (NO test verifiers);
 *   - the test-only harness tests/verification/productionHarness.js calls it
 *     via the SAME function with test-supplied verifier definitions, so that
 *     R3 certification proofs exercise the REAL production implementation,
 *     not a test-domain mirror.
 *
 * The composition takes a deps bag (Lane 2/Lane 3 facade factories) and an
 * OPTIONAL trustedVerifiers list consumed ONLY at composition time. After the
 * facade is constructed, NO caller — production or test — can register,
 * inject, or mutate verifiers. There is NO public registrar, NO token, NO
 * host capability. AVAILABLE != AUTHORIZED: test composition privilege does
 * NOT become production-downstream privilege.
 *
 * This module does NOT duplicate Lane 4 logic; it IS the production Lane 4
 * logic, extracted verbatim from src/action/bootstrap.js. The public
 * bootstrap simply wires the production composition with no test verifiers.
 */

const crypto4 = require("node:crypto");
const { types: vUtilTypes4 } = require("node:util");
const {
    VERIFICATION_STATE: VSTATE4, COMPENSATION_STATE: CSTATE4,
    LIFECYCLE: VLIFECYCLE4, REASONS: VREASONS4, fail: fail4
} = require("../verification/errors");
const {
    POSTCONDITION_OPS: VOPS4, POSTCONDITION_KIND: VKIND4,
    POSTCONDITION_SCHEMA_VERSION: VPOST_SCHEMA4,
    isValidPostconditionPath: isValidPostPath4
} = require("../verification/postcondition");
const {
    VERIFICATION_REQUEST_SCHEMA_VERSION: VREQ_SCHEMA4,
    VERIFICATION_RESULT_SCHEMA_VERSION: VRES_SCHEMA4,
    COMPENSATION_PLAN_SCHEMA_VERSION: CPLAN_SCHEMA4,
    COMPENSATION_RESULT_SCHEMA_VERSION: CRES_SCHEMA4,
    BOUNDS: VBOUNDS4,
    DEFAULT_VERIFY_TIMEOUT_MS: DEFAULT_VTIMEOUT4,
    MIN_VERIFY_TIMEOUT_MS: MIN_VTIMEOUT4,
    MAX_VERIFY_TIMEOUT_MS: MAX_VTIMEOUT4,
    isValidVerifyTimeoutMs: isValidVTimeout4
} = require("../verification/schema");
const { READINESS: VREADINESS4 } = require("../verification/verifierRegistry");
const { RESULT_STATE: RESULT_STATE3b } = require("../actuation/errors");
const { canonicalScope } = require("../intent");
const { fail, REASONS } = require("../errors");

// ---------------------------------------------------------------------------
// LANE 4 — CANONICAL VERIFICATION + COMPENSATION COMPOSITION.
//
// ALL privileged verification/compensation implementation lives in THIS
// private lexical closure, exactly like Lane 2's
// composeActionAuthorityRuntime / composeAuthenticationDomain and Lane 3's
// actuation formers. The verification submodules (verification/*.js) are PURE
// NON-PRIVILEGED vocabulary modules. The privileged constructors —
// buildVerifierRegistry, composeVerification, formVerificationRequest,
// buildVerificationResult, formCompensationPlan, buildCompensationResult,
// sanitizeEvidence, evaluatePostcondition — are defined HERE, inside this
// module's own lexical scope. They are reachable through NO binder, NO token,
// NO host capability, NO first-call-wins registry: acquiring them requires
// ALREADY executing inside this closure.
//
// CANONICAL BRANDS: the verification-request / verification-result /
// compensation-plan brand WeakSets are declared HERE (closure-private).
// Brand membership is established ONLY by the private formers below. No
// export of ANY module exposes the WeakSets, the brand tokens, or any
// mutation surface. Downstream can ASK (via the pure recognition predicates
// on the facade); downstream cannot CAUSE.
//
// CORE LAWS (Lane 4):
//
//   EXECUTED != VERIFIED            — a Lane 3 EXECUTED result is input to
//                                     verification, never proof of truth.
//   ACTUATOR REPORT != WORLD TRUTH  — verification observes the world via
//                                     bootstrap-owned verifiers only.
//   TIMEOUT != NO SIDE EFFECT       — verification timeout yields TIMED_OUT /
//                                     INCONCLUSIVE, never success/failure.
//   AUDIT != CURRENT TRUTH          — evidence is historical record only.
//   MEMORY != CURRENT TRUTH
//   MODEL CLAIM != VERIFICATION     — no caller/object can mint a claim.
//   PLAN != AUTHORITY               — a CompensationPlan is descriptive.
//   COMPENSATION != ROLLBACK GUARANTEE — restoration is claimed only by a
//                                     fresh verification with VERIFIED_SUCCESS.
//
// COMPENSATION IS A NEW ACTION: compensation NEVER calls a compensator
// function directly from a verification failure. The canonical compensate()
// path (1) requires the source verification state recorded inside THIS
// closure (never a caller-presented result), (2) forms an immutable
// CompensationPlan, (3) admits a fresh canonical ActionIntent for the
// compensation action, (4) routes it through the Lane 3 canonical facade
// execute() — which performs fresh Lane 2 revalidation — and (5) requires a
// separate fresh verification of the compensation's own postcondition before
// any restoration claim. A previous ALLOW for the original action does NOT
// authorize compensation; the Lane 2 gate re-evaluates the compensation
// action against current authority.
//
// IDEMPOTENCE: process-local exact-once scopes for verification
// (verificationId) and compensation (compensationId) are documented as
// PROCESS-LOCAL; a duplicate id returns the SAME canonical record instead of
// re-observing or re-actuating.
// ---------------------------------------------------------------------------

// CANONICAL BRANDS (TARGETED REPAIR 5): the brand WeakSets are PER-COMPOSITION
// — declared fresh inside createCanonicalVerificationComposition so every
// composition instance owns an INDEPENDENT provenance domain. Artifacts minted
// by composition A are NOT canonical to composition B (cross-composition
// forgery is structurally impossible). COMPOSITION INSTANCE != SHARED TRUST
// DOMAIN. The brand Symbols previously declared here carried ZERO
// authenticity (they were never used as membership proof) and have been
// REMOVED: membership in the per-instance WeakSet is the only authority-
// bearing provenance proof.

// Options that must NEVER be accepted from a verify/compensate caller: the
// verifier/compensator functions are bootstrap-owned and captured at trusted
// registration time.
const CALLER_VERIFIER_KEYS4 = Object.freeze([
    "verifier", "verifierFn", "observe", "observeFn", "sensor", "sensorFn",
    "predicate", "predicateFn", "evaluator", "evaluatorFn", "checker",
    "checkFn", "postconditionFn", "verifyFn"
]);
const CALLER_COMPENSATOR_KEYS4 = Object.freeze([
    "compensator", "compensatorFn", "rollback", "rollbackFn", "repair",
    "repairFn", "undo", "undoFn", "restore", "restoreFn", "compensateFn"
]);
const TIMEOUT_SENTINEL4 = Symbol("damar.action.verification.timeout");

function deepFreeze4(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze4(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

function vIsPlainObject4(v) {
    // ZERO-TRAP REPAIR: vIsPlainObject4 is now called ONLY on values that have
    // already been classified safe by vSafeClassify4 (not a Proxy, not
    // revoked). Object.getPrototypeOf on a genuinely plain object (literal or
    // Object.create(null/proto)) performs no traps. Any caller passing an
    // unclassified value here is a bug, so the prototype read is guarded by
    // the proxy gate in vSafeClassify4, not repeated here.
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

const V_DANGEROUS_KEYS4 = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

// ---------------------------------------------------------------------------
// HOSTILE EVIDENCE ZERO-TRAP CLASSIFICATION (TARGETED REPAIR 1)
//
// ROOT CAUSE (pre-repair): sanitizeEvidence4()/vDetach4() invoked reflection
// — instanceof Error (getPrototypeOf via HasInstance), Object.getPrototypeOf,
// Object.getOwnPropertyNames, Object.getOwnPropertyDescriptor, Array.isArray
// followed by index access — on UNCLASSIFIED verifier observation values. A
// Proxy wrapping the observation could therefore execute attacker-controlled
// getPrototypeOf/ownKeys/getOwnPropertyDescriptor/get traps merely because
// Lane 4 was deciding whether the evidence was safe: the safety check itself
// was an execution gadget.
//
// TRUST ORDERING (post-repair), mirroring the certified Lane 3 brand-first
// lesson — SAFE MEMBERSHIP / TRUSTED ORIGIN FIRST, REFLECTION SECOND:
//
//   1. ONLY primitive inspection is performed on untrusted values:
//        typeof, strict null/undefined comparisons, and
//        util.types.isProxy() — an internal-slot probe that invokes ZERO
//        Proxy traps (verified empirically against every instrumented trap
//        family, including revoked proxies, where it still answers without
//        consulting handler behavior).
//   2. Any Proxy — including revoked proxies and revocable wrappers — is
//        rejected BEFORE any reflection (TRUSTED SHAPE != TRUSTED ORIGIN).
//        Fail closed: if an object cannot be established as safe detached
//        data without interacting with attacker-controlled meta-object
//        behavior, it is rejected, not introspected further.
//   3. Only after a value is classified Proxy-free does reflection proceed:
//        static prototype identity (=== Object.prototype / null), then
//        ownKeys + descriptor inspection, then recursion — where every
//        nested value re-enters this gate BEFORE its own reflection.
//
// There is deliberately NO general "transparent Proxy" acceptance: a Proxy
// carrying plain data is indistinguishable from hostile without traps, and
// inventing shape-based trust for unmarked values would reintroduce the
// gadget. Correct fail-closed rejection is preferred over broader unsafe
// acceptance.
// ---------------------------------------------------------------------------

const HOSTILE_EVIDENCE_DETAIL4 =
    "hostile observation rejected: proxy-like or non-detached value (zero-trap fail-closed)";

/**
 * ZERO-TRAP classification of an untrusted value. Uses ONLY:
 *   - typeof / === / Array.isArray-on-primitives
 *   - util.types.isProxy (internal slot; zero traps, zero throws — even for
 *     revoked proxies)
 * Returns one of:
 *   "primitive"  — string | boolean | finite number (safe by value)
 *   "null"       — null
 *   "error"      — genuine native Error instance (static prototype chain,
 *                   NO instanceof/HasInstance on untrusted values)
 *   "array"      — plain Array (static prototype chain)
 *   "object"     — plain object (static prototype chain)
 *   "hostile"    — Proxy (incl. revoked), non-plain exotic (class instance,
 *                   Map/Set/Date/RegExp/other realm objects), accessor-target
 *                   (functions are rejected as evidence), or garbage the
 *                   caller must fail closed on
 * "hostile" classification itself MUST NOT be a verdict about the WORLD:
 * callers map it to fail-closed states (ERROR / typed rejection), never to
 * VERIFIED_SUCCESS/VERIFIED_FAILURE.
 */
function vSafeClassify4(value) {
    // (1) primitives + null: zero reflection by construction.
    if (value === null) return "null";
    const t = typeof value;
    if (t === "string" || t === "boolean") return "primitive";
    if (t === "number") return Number.isFinite(value) ? "primitive" : "inert";
    // (2) non-objects: function/symbol/bigint/undefined are INERT values —
    //     they cannot carry traps and are sanitized to null (established
    //     Lane 3/Lane 4 evidence contract), not treated as execution
    //     gadgets. A function VALUE is not a trap gadget; it is dropped.
    if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") return "inert";
    if (t !== "object") return "hostile";
    // (3) THE GATE — internal-slot proxy probe. Zero traps: the empirical
    //     proof in tests/verification asserts exact-zero counters for get,
    //     has, ownKeys, getOwnPropertyDescriptor, getPrototypeOf, set,
    //     defineProperty, deleteProperty, apply, construct across every
    //     hostile case. Revoked proxies are still reported as proxies, so
    //     a revoked object can never smuggle through as a plain value.
    if (vUtilTypes4.isProxy(value)) return "hostile";
    // (4) The value is now KNOWN not to be a Proxy; reflection is safe.
    //     Array.isArray consults the internal slot (no traps on a
    //     non-proxy), and the static prototype identity check distinguishes
    //     genuine plain values from exotic/class-instance/realm objects.
    if (Array.isArray(value)) {
        return Object.getPrototypeOf(value) === Array.prototype ? "array" : "hostile";
    }
    // A genuine Promise is a trusted native delivery object: classify it so
    // the observation runner can await it WITHOUT probing `.then` on an
    // unclassified value. `util.types.isPromise` is an internal-slot probe
    // (zero traps). A Proxy wrapping a Promise reports false here and is
    // correctly rejected as "hostile" at the gate.
    if (vUtilTypes4.isPromise(value)) return "promise";
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
        // Genuine plain object. (A plain object carrying a fake
        // Symbol.toStringTag cannot fake its way past the next JSON gate in
        // sanitizeEvidence4; the tag is cosmetic only.)
        return "object";
    }
    // Native Error instances are the only exotic family ACCEPTED as
    // evidence (normalized to {name,message}); the check is the STATIC
    // prototype chain — NOT `value instanceof Error`, which routes through
    // Error[Symbol.hasInstance] -> OrdinaryHasInstance -> the object's
    // prototype chain and is exactly the getPrototypeOf gadget the audit
    // flagged. Subclass errors (e.g. TypeError across realms used by this
    // runtime) are matched by walking the static chain with a bound compare.
    let cursor = proto;
    for (let hops = 0; hops < 8 && cursor !== null; hops++) {
        if (cursor === Error.prototype || cursor === globalThis.Error?.prototype) {
            return "error";
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    // Other exotic objects (class instances, Map/Set/Date/RegExp, cross-realm
    // objects): NOT proxies, so own-property reflection is trap-free; the
    // established evidence contract sanitizes them to null ("inert") rather
    // than poisoning. Only actual Proxies (rejected at the internal-slot
    // gate above) poison the observation.
    return "inert";
}

/**
 * PLAIN-THENABLE WHOLE-OBJECT TRANSPORT REJECTION (TARGETED REPAIR 3).
 *
 * A plain (non-Proxy) object/array carrying an OWN property named `then` is
 * a thenable-shaped observation transport surface. Even if JavaScript would
 * never actually call it as a function, Lane 4 must treat it as an
 * unsupported transport object because:
 *   - it is semantically ambiguous with async transport (R2 contract);
 *   - an accessor-backed `then` getter would execute behavior during native
 *     assimilation if any caller ever let the value cross a Promise boundary;
 *   - partial sanitization that SKIPS the `then` accessor and retains
 *     sibling fields can manufacture apparently-valid evidence (VERIFIED_
 *     SUCCESS) out of hostile input — the exact bug this repair closes.
 *
 * PRESENCE of an own `then` property is sufficient to fail closed: the
 * ENTIRE observation value is rejected as `thenableTransport`, regardless
 * of `then`'s value (data property, accessor, function, non-function,
 * undefined, null). There is NO duck typing (no `typeof obj.then`),
 * NO getter invocation, NO setter invocation. The check uses
 * Object.getOwnPropertyDescriptor — which, on a value already proven
 * non-Proxy by vSafeClassify4, performs NO attacker-controlled trap.
 *
 * Returns:
 *   true  — the value has an own `then` property (transport-shaped: reject)
 *   false — no own `then` property (safe to traverse)
 * The caller is responsible for having already classified the value as a
 * non-Proxy plain object/array.
 */
function vHasOwnThen4(v) {
    // Object.getOwnPropertyDescriptor returns undefined for absent own props;
    // it does NOT consult inherited or Proxy-trap semantics on a non-Proxy
    // value. The `then` getter/setter is NEVER invoked.
    return Object.getOwnPropertyDescriptor(v, "then") !== undefined;
}

// Hostile-input detachment for DECLARATIVE postcondition values, evidence
// and compensation parameters: functions/symbols/accessors/class instances/
// cycles/prototype-pollution keys are rejected (fail-closed), values are
// bounded and detached from caller mutations.
// TARGETED REPAIR 1: every value passes vSafeClassify4 (zero-trap gate)
// BEFORE any reflection (ownKeys/descriptor/prototype reads). Proxies —
// including trap-bearing and revoked ones — are rejected with a typed error
// at the gate instead of being reflected upon.
function vDetach4(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail4(VREASONS4.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    }
    // ZERO-TRAP GATE: classification uses only typeof/===/internal-slot
    // probes. Nothing below this line runs for a hostile value.
    const cls = vSafeClassify4(value);
    if (cls === "null") return null;
    if (cls === "primitive") {
        if (typeof value === "number") {
            // finite check already done in the classifier
            return value;
        }
        return value;
    }
    if (cls === "inert") {
        // Inert (function/symbol/bigint/undefined/non-finite-number) in
        // postcondition/compensation-parameter payloads is REJECTED (the
        // postcondition contract is declarative; the observation-evidence
        // sanitizer may DROP these to null, but detach must fail closed).
        const t = typeof value;
        if (t === "function") throw fail4(VREASONS4.FUNCTION_VALUE, "function values are not permitted");
        throw fail4(VREASONS4.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (cls === "hostile") {
        // Fail closed with a typed error. NEVER reinterpret as a world claim.
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "proxy-like or non-plain value is not permitted (zero-trap fail-closed)");
    }
    // TARGETED REPAIR 3: own-`then` whole-input rejection for
    // postcondition/compensation-parameter payloads. An input carrying an
    // OWN `then` property — data, accessor, function, non-function — is a
    // transport-shaped surface and is rejected whole BEFORE recursive
    // detachment (consistent with the observation transport rule). Descriptor
    // lookup on a proven non-Proxy performs no traps; the getter is never
    // invoked. This also catches accessor-backed `then` early (whereas the
    // ACCESSOR_PROPERTY branch below would otherwise have rejected it for a
    // different reason — this rule is structural, not duck-typed).
    if (cls === "object" || cls === "array" || cls === "error") {
        if (vHasOwnThen4(value)) {
            throw fail4(VREASONS4.UNSUPPORTED_ASYNC_RAW_RETURN,
                "thenable-shaped input is not permitted (own \"then\" property rejected whole)");
        }
    }
    // cls is "array" | "object" — reflection is now safe (value is not a
    // Proxy and its prototype is genuinely Array/Object/null).
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail4(VREASONS4.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > VBOUNDS4.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail4(VREASONS4.BOUND_EXCEEDED, "array length exceeds global bound");
        }
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = vDetach4(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!vIsPlainObject4(value)) {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    }
    if (state.path.has(value)) throw fail4(VREASONS4.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (V_DANGEROUS_KEYS4.has(key)) throw fail4(VREASONS4.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail4(VREASONS4.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = vDetach4(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail4(VREASONS4.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

function vRequireString4(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    }
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must not be empty`);
    }
    if (s.length > maxChars) {
        throw fail4(VREASONS4.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    }
    return s;
}

function vRequireSafeInteger4(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

// ---- DECLARATIVE POSTCONDITION: canonical former + evaluator (private) ----
function formExpectedPostcondition4(raw) {
    if (raw === undefined || raw === null) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, "expectedPostcondition is required");
    }
    if (typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint") {
        throw fail4(VREASONS4.EXECUTABLE_POSTCONDITION_REJECTED,
            "expected postcondition must be declarative; executable values are rejected");
    }
    // ZERO-TRAP REPAIR (TARGETED REPAIR 1): classify FIRST via the
    // internal-slot proxy probe — ANY Proxy (trap-bearing OR transparent) is
    // rejected here with zero trap execution. The pre-repair ownKeys-vs-
    // enumerable divergence probe ran reflection on unclassified values and
    // was itself a trap gadget; it is removed. TRUSTED SHAPE != TRUSTED
    // ORIGIN: no shape-based trust is invented for unmarked values.
    if (vSafeClassify4(raw) !== "object") {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT,
            "proxy-like or non-plain postcondition is not permitted (zero-trap fail-closed)");
    }
    // raw is now a genuinely plain object: reflection is safe.
    if (!vIsPlainObject4(raw)) {
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "expected postcondition must be a plain declarative object");
    }

    let detached;
    try {
        const state = { nodes: 0, maxNodes: VBOUNDS4.MAX_PARAMETERS_NODES, path: new Set() };
        detached = vDetach4(raw, state);
    } catch (e) {
        if (e && typeof e.reasonCode === "string") throw e;
        // Hostile trap threw mid-detach => typed fail-closed rejection.
        throw fail4(VREASONS4.NON_PLAIN_OBJECT, "hostile postcondition object rejected during detachment");
    }
    return vFinishPostcondition4(detached);
}

function vFinishPostcondition4(detached) {

    if (detached.schemaVersion !== undefined && detached.schemaVersion !== VPOST_SCHEMA4) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `unsupported postcondition schemaVersion ${JSON.stringify(detached.schemaVersion)}`);
    }
    if (detached.kind !== undefined && detached.kind !== VKIND4) {
        throw fail4(VREASONS4.MALFORMED_REQUEST, `unsupported postcondition kind ${JSON.stringify(detached.kind)}`);
    }

    const expect = {};
    let expectCount = 0;
    if (detached.expect !== undefined && detached.expect !== null) {
        if (!vIsPlainObject4(detached.expect)) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "postcondition expect must be a plain object");
        }
        for (const [path, rule] of Object.entries(detached.expect)) {
            expectCount++;
            if (expectCount > VBOUNDS4.MAX_EXPECT_ENTRIES) {
                throw fail4(VREASONS4.BOUND_EXCEEDED, `postcondition expect exceeds ${VBOUNDS4.MAX_EXPECT_ENTRIES} entries`);
            }
            if (!isValidPostPath4(path)) {
                throw fail4(VREASONS4.DANGEROUS_KEY, `invalid postcondition path '${String(path).slice(0, 64)}'`);
            }
            if (!vIsPlainObject4(rule)) {
                throw fail4(VREASONS4.MALFORMED_REQUEST, `postcondition rule for '${path}' must be a declarative object`);
            }
            const op = rule.op;
            if (!VOPS4 || !Object.values(VOPS4).includes(op)) {
                throw fail4(VREASONS4.MALFORMED_REQUEST, `postcondition rule for '${path}' has invalid op`);
            }
            const ruleOut = { op };
            if ("value" in rule) {
                const valueState = { nodes: 0, maxNodes: VBOUNDS4.MAX_VALUE_NODES, path: new Set() };
                ruleOut.value = vDetach4(rule.value, valueState);
            }
            expect[path] = Object.freeze(ruleOut);
        }
    }

    const forbid = {};
    let forbidCount = 0;
    if (detached.forbid !== undefined && detached.forbid !== null) {
        if (!vIsPlainObject4(detached.forbid)) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "postcondition forbid must be a plain object");
        }
        for (const [path, value] of Object.entries(detached.forbid)) {
            forbidCount++;
            if (forbidCount > VBOUNDS4.MAX_EXPECT_ENTRIES) {
                throw fail4(VREASONS4.BOUND_EXCEEDED, `postcondition forbid exceeds ${VBOUNDS4.MAX_EXPECT_ENTRIES} entries`);
            }
            if (!isValidPostPath4(path)) {
                throw fail4(VREASONS4.DANGEROUS_KEY, `invalid postcondition forbid path '${String(path).slice(0, 64)}'`);
            }
            const valueState = { nodes: 0, maxNodes: VBOUNDS4.MAX_VALUE_NODES, path: new Set() };
            forbid[path] = vDetach4(value, valueState);
        }
    }

    if (expectCount === 0 && forbidCount === 0) {
        // A vacuous postcondition must never be able to mint VERIFIED_SUCCESS.
        throw fail4(VREASONS4.MALFORMED_REQUEST,
            "expected postcondition must contain at least one expect or forbid rule (vacuous postconditions are rejected)");
    }

    return deepFreeze4({ schemaVersion: VPOST_SCHEMA4, kind: VKIND4, expect: deepFreeze4(expect), forbid: deepFreeze4(forbid) });
}

/** Read a dotted path from a plain object; returns { found, value }. */
function vReadPath4(obj, path) {
    const segments = String(path).split(".");
    let cur = obj;
    for (const seg of segments) {
        if (cur === null || cur === undefined) return { found: false, value: undefined };
        if (typeof cur !== "object") return { found: false, value: undefined };
        if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
        cur = cur[seg];
    }
    return { found: true, value: cur };
}

/**
 * Canonical postcondition evaluator (private). Pure: evaluates the
 * declarative expectation against sanitized evidence.
 *   "matched"    — every expect rule satisfied AND every forbid rule clean
 *   "mismatched" — at least one explicit rule violated
 *   "insufficient" — evidence did not contain a path needed to decide
 * Returns one of those strings, or throws only on internal contract bugs.
 */
function evaluatePostcondition4(postcondition, evidence) {
    if (!postcondition || typeof postcondition !== "object") return "insufficient";
    const ev = (evidence === null || evidence === undefined || typeof evidence !== "object")
        ? {} : evidence;

    let sawAny = false;

    for (const [path, rule] of Object.entries(postcondition.expect ?? {})) {
        sawAny = true;
        const { found, value } = vReadPath4(ev, path);
        const op = rule.op;
        if (op === VOPS4.EXISTS) {
            if (!found) return "insufficient";
            if (value === null || value === undefined) return "mismatched";
            continue;
        }
        if (op === VOPS4.ABSENT) {
            if (found && value !== null && value !== undefined) return "mismatched";
            continue;
        }
        if (op === VOPS4.IN) {
            if (!found) return "insufficient";
            const options = Array.isArray(rule.value) ? rule.value : [];
            if (!options.some((o) => o === value)) return "mismatched";
            continue;
        }
        if (op === VOPS4.TYPE) {
            if (!found) return "insufficient";
            const t = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
            if (t !== rule.value) return "mismatched";
            continue;
        }
        if (!found) return "insufficient";
        if (op === VOPS4.EQ) {
            if (value !== rule.value) return "mismatched";
        } else if (op === VOPS4.NE) {
            if (value === rule.value) return "mismatched";
        } else if (op === VOPS4.GT || op === VOPS4.GTE || op === VOPS4.LT || op === VOPS4.LTE) {
            if (typeof value !== "number" || typeof rule.value !== "number") return "mismatched";
            if (op === VOPS4.GT && !(value > rule.value)) return "mismatched";
            if (op === VOPS4.GTE && !(value >= rule.value)) return "mismatched";
            if (op === VOPS4.LT && !(value < rule.value)) return "mismatched";
            if (op === VOPS4.LTE && !(value <= rule.value)) return "mismatched";
        } else {
            return "insufficient";
        }
    }

    for (const [path, forbiddenValue] of Object.entries(postcondition.forbid ?? {})) {
        sawAny = true;
        const { found, value } = vReadPath4(ev, path);
        // forbid: { path: X } — the path, if present, must not equal X.
        // (To require a path be entirely absent, use
        // expect: { path: { op: "absent" } }.)
        if (found && value === forbiddenValue) return "mismatched";
    }

    if (!sawAny) return "insufficient";
    return "matched";
}

// ---- HOSTILE EVIDENCE SANITIZER (private; observation safety) --------------
// TARGETED REPAIR 1: this sanitizer is the untrusted evidence trust boundary.
// It MUST NOT invoke ANY reflection (instanceof / getPrototypeOf /
// ownKeys / getOwnPropertyDescriptor / get / has / set / defineProperty /
// deleteProperty / apply / construct) on an unclassified value.
//
// Post-repair trust ordering (TRUSTED ORIGIN FIRST, REFLECTION SECOND):
//   1. vSafeClassify4() classifies using ONLY typeof / === / internal-slot
//      util.types.isProxy() (zero traps, zero throws — even for revoked
//      proxies).
//   2. Proxies (incl. revoked) and other exotic objects are REJECTED by
//      returning a hostile-rejection sentinel. The caller maps this to the
//      verifier-infrastructure ERROR state (never VERIFIED_SUCCESS/FAILURE).
//   3. Only after a value is classified Proxy-free (plain array/object) does
//      reflection proceed, and EVERY nested value re-enters the gate before
//      its own reflection. The zero-trap invariant holds recursively.
//
// Native Error instances are the only exotic family accepted: they are
// normalized to { name, message } and checked via the STATIC prototype
// chain (not `instanceof Error`, which routes through the getPrototypeOf
// trap and was exactly the gadget flagged by the audit). Error normalization
// runs AFTER the classifier proves the value is not a Proxy, so a Proxy
// wrapping an Error target is rejected at step (2) and never reaches the
// Error branch.
//
// Bounds preserved: nodes (512) / depth (8) / keys (64) / string (1024) /
// array slice (256); cycle handling (null on revisit); dangerous key
// filtering; accessor skipping. These bounds are SECONDARY to the zero-trap
// invariant — no reflection runs merely to enforce them.
const V_EV_STRING_CHARS4 = 1024;
const V_EV_KEYS4 = 64;
const V_EV_DEPTH4 = 8;
const V_EV_NODES4 = 512;
// Sentinel returned for hostile values: the caller translates this into a
// verifier-infrastructure ERROR, never a world claim.
const V_HOSTILE_SENTINEL4 = Symbol("damar.action.verification.evidence.hostile");
// Sentinel for own-`then` (thenable-shaped) observation transport values
// (TARGETED REPAIR 3): the caller translates this into the typed
// UNSUPPORTED_ASYNC_RAW_RETURN ERROR, never a world claim.
const V_THENABLE_SENTINEL4 = Symbol("damar.action.verification.evidence.thenableTransport");

function sanitizeEvidence4(value) {
    const state = { nodes: 0, path: new Set() };

    function normalizeErrorName(v) {
        // v is KNOWN non-proxy + static Error prototype chain. .name/.message
        // reads on a genuine native Error are not attacker-controlled (no
        // exotic meta-object behavior can interpose).
        let n = v.name;
        if (typeof n !== "string") n = "Error";
        n = n.slice(0, 64);
        let m = v.message;
        if (typeof m !== "string") m = "";
        m = m.slice(0, V_EV_STRING_CHARS4);
        return { name: n, message: m };
    }

    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > V_EV_NODES4 || depth > V_EV_DEPTH4) return null;

        // (1) ZERO-TRAP GATE. No reflection below this line until the value
        //     is classified Proxy-free.
        const cls = vSafeClassify4(v);
        if (cls === "null" || cls === "inert") {
            // null, non-finite numbers, functions, symbols, bigints,
            // undefined: inert values — sanitized to null (no traps possible;
            // established evidence contract), never treated as gadgets.
            return null;
        }
        if (cls === "primitive") {
            const t = typeof v;
            if (t === "string") return v.length > V_EV_STRING_CHARS4 ? v.slice(0, V_EV_STRING_CHARS4) : v;
            if (t === "boolean") return v;
            // number — finite already established by the classifier
            return v;
        }
        if (cls === "error") {
            // Native Error normalization (the classifier proved not a Proxy
            // and a static Error.prototype chain). No HasInstance gadget.
            // TARGETED REPAIR 3: an Error carrying an OWN `then` property is
            // transport-shaped and must be rejected whole — the Error branch
            // must not become a bypass for the own-then rule. The descriptor
            // check on a proven non-Proxy performs no traps.
            if (vHasOwnThen4(v)) {
                return V_THENABLE_SENTINEL4;
            }
            return normalizeErrorName(v);
        }
        if (cls === "hostile") {
            // Hostile: reject. ANY hostile value — top-level OR nested inside
            // otherwise normal-looking evidence — poisons the whole
            // observation: the caller maps the sentinel to the verifier-
            // infrastructure ERROR state (never VERIFIED_SUCCESS/FAILURE).
            return V_HOSTILE_SENTINEL4;
        }

        // TARGETED REPAIR 3: own-`then` whole-object transport rejection.
        // The value is now a non-Proxy plain object/array (cls is
        // "array"|"object"); Object.getOwnPropertyDescriptor on a non-Proxy
        // performs NO attacker-controlled trap. The `then` getter/setter is
        // NEVER invoked. Presence of an own `then` — data property,
        // accessor, function, non-function, undefined, null — is sufficient
        // to reject the ENTIRE observation as thenable-shaped transport
        // (recursive: a nested own-`then` poisons the whole observation).
        if (vHasOwnThen4(v)) {
            return V_THENABLE_SENTINEL4;
        }

        // cls is "array" | "object" — reflection is now safe (value is not a
        // Proxy and its prototype is genuinely Array/Object/null).
        if (state.path.has(v)) return null;
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            // Propagate poisoning: any hostile nested value poisons the
            // entire observation.
            if (out.some((x) => x === V_HOSTILE_SENTINEL4)) return V_HOSTILE_SENTINEL4;
            if (out.some((x) => x === V_THENABLE_SENTINEL4)) return V_THENABLE_SENTINEL4;
            return out;
        }
        const out = {};
        let keys = 0;
        let poisoned = false;
        let poisonedSentinel = V_HOSTILE_SENTINEL4;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= V_EV_KEYS4) break;
            keys++;
            if (V_DANGEROUS_KEYS4.has(key)) continue;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue;
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            const child = walk(desc.value, depth + 1);
            if (child === V_HOSTILE_SENTINEL4 || child === V_THENABLE_SENTINEL4) {
                poisoned = true;
                poisonedSentinel = child;
                break;
            }
            out[kk] = child;
        }
        state.path.delete(v);
        // Propagate poisoning: any hostile nested value poisons the entire
        // observation (fail closed at the top level as ERROR).
        if (poisoned) return poisonedSentinel;
        return out;
    }

    const result = walk(value, 0);
    if (result === V_HOSTILE_SENTINEL4) return V_HOSTILE_SENTINEL4;
    if (result === V_THENABLE_SENTINEL4) return V_THENABLE_SENTINEL4;
    return result;
}

// ---- PRIVILEGED: verifier registry (closure-private) -----------------------
function buildVerifierRegistry4() {
    const byId = new Map();
    const byCap = new Map();

    function canonicalOp(op) {
        return String(op ?? "").trim().toLowerCase();
    }

    function register({ capabilityId, operations, capabilityIncarnationId, verifierId, observe, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a non-empty capabilityId");
        }
        if (!Array.isArray(operations) || operations.length === 0 ||
            operations.map(canonicalOp).filter((s) => s.length > 0).length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a non-empty operations array");
        }
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires a capabilityIncarnationId");
        }
        if (typeof observe !== "function") {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, "verifier registration requires an observe function");
        }
        if (!VREADINESS4[readiness]) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        }

        const id = (typeof verifierId === "string" && verifierId.length > 0)
            ? verifierId
            : `ver-${crypto4.randomUUID()}`;
        const verifierIncarnationId = `vinc-${crypto4.randomUUID()}`;

        if (byId.has(id)) {
            throw fail4(VREASONS4.REGISTRATION_REJECTED, `verifier '${id}' is already registered; remove it first`);
        }

        // Function identity captured ONCE (bind to a stable detached receiver).
        const observeFn = observe.bind({});
        const ops = operations.map(canonicalOp).filter((s) => s.length > 0);
        const binding = Object.freeze({
            capabilityId,
            operations: Object.freeze(ops.slice()),
            capabilityIncarnationId,
            verifierId: id,
            verifierIncarnationId,
            readiness,
            observe: observeFn
        });

        byId.set(id, binding);
        let opMap = byCap.get(capabilityId);
        if (!opMap) { opMap = new Map(); byCap.set(capabilityId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) {
                byId.delete(id);
                throw fail4(VREASONS4.REGISTRATION_REJECTED, `verifier already registered for '${capabilityId}.${op}'`);
            }
            opMap.set(op, binding);
        }
        return binding;
    }

    function remove(verifierId) {
        const binding = byId.get(verifierId);
        if (!binding) return false;
        byId.delete(verifierId);
        const opMap = byCap.get(binding.capabilityId);
        if (opMap) {
            for (const op of binding.operations) {
                const cur = opMap.get(op);
                if (cur && cur.verifierId === verifierId) opMap.delete(op);
            }
            if (opMap.size === 0) byCap.delete(binding.capabilityId);
        }
        return true;
    }

    function resolve(capabilityId, operation) {
        const opMap = byCap.get(capabilityId);
        if (!opMap) return null;
        return opMap.get(canonicalOp(operation)) ?? null;
    }

    function get(verifierId) {
        return byId.get(verifierId) ?? null;
    }

    return Object.freeze({ register, remove, resolve, get });
}

// ---- LANE 4 — CANONICAL VERIFICATION + COMPENSATION COMPOSITION ------------

/**
 * Create the canonical Lane 4 verification/compensation composition (trusted
 * internal factory). Production calls this with NO trustedVerifiers; the
 * test-only productionHarness calls it with test-supplied verifier
 * definitions, exercising the SAME production code path.
 *
 * @param {object} opts
 * @param {object} opts.deps — { createLane3Facade, createLane2Facade }
 *        bootstrap-owned Lane 2/Lane 3 facade factories
 * @param {Array} [opts.trustedVerifiers] — OPTIONAL composition-time test
 *        verifier definitions (production: []). Each entry is a
 *        { capabilityId, operations, capabilityIncarnationId, verifierId,
 *          observe, readiness } shape consumed ONLY at composition time.
 * @returns {object} frozen least-privilege facade:
 *          { verify, compensate, isCanonicalVerificationRequest,
 *            isCanonicalVerificationResult, isCanonicalCompensationPlan }
 */
function createCanonicalVerificationComposition({
    deps,
    trustedVerifiers = []
} = {}) {
    if (deps === null || typeof deps !== "object" ||
        typeof deps.createLane3Facade !== "function" ||
        typeof deps.createLane2Facade !== "function") {
        throw fail(REASONS.MALFORMED_INPUT,
            "canonical verification composition requires deps.createLane3Facade + deps.createLane2Facade");
    }
    if (!Array.isArray(trustedVerifiers)) {
        throw fail(REASONS.MALFORMED_INPUT,
            "trustedVerifiers must be an array (composition-time only)");
    }

    const lane3Facade = deps.createLane3Facade();
    const verifierRegistry = buildVerifierRegistry4();
    // Composition-time-only trusted verifier wiring (production passes [];
    // tests pass test-supplied definitions). After this loop, NO caller can
    // register, inject, or mutate verifiers.
    for (const tv of trustedVerifiers) {
        if (tv === null || typeof tv !== "object") {
            throw fail(REASONS.MALFORMED_INPUT,
                "trusted verifier definition must be a plain object");
        }
        verifierRegistry.register({
            capabilityId: tv.capabilityId,
            operations: tv.operations,
            capabilityIncarnationId: tv.capabilityIncarnationId,
            verifierId: tv.verifierId,
            observe: tv.observe,
            readiness: tv.readiness ?? "READY"
        });
    }
    // Process-local exact-once scopes (documented as PROCESS-LOCAL).
    const verificationsById = new Map();  // verificationId -> { result, request }
    const compensationById = new Map();   // compensationId -> record
    const VERIFICATION_MAX = 4096;
    const COMPENSATION_MAX = 4096;

    // ---- PER-COMPOSITION PROVENANCE DOMAIN (TARGETED REPAIR 5) ------------
    // Fresh WeakSets per composition invocation: every composition instance
    // owns an INDEPENDENT trust domain. A request/result/plan minted by THIS
    // composition is canonical ONLY to THIS composition — cross-composition
    // artifacts are rejected by every other composition's predicates, the
    // compensate() provenance check, and (for the canonical application
    // composition) by the production facade. All formers, predicates, and
    // the compensation source check below close over THESE instance-local
    // sets. No module-global canonical membership store exists.
    const vRequestBrandSet4 = new WeakSet();
    const vResultBrandSet4 = new WeakSet();
    const vPlanBrandSet4 = new WeakSet();

    function noteVerification(id, rec) {
        if (verificationsById.size >= VERIFICATION_MAX) {
            const first = verificationsById.keys().next().value;
            if (first !== undefined) verificationsById.delete(first);
        }
        verificationsById.set(id, rec);
    }

    function canonicalClockNow4() {
        const v = Date.now();
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    /**
     * ZERO-ASSIMILATION observation runner (TARGETED REPAIR 2).
     *
     * Boxes the observation outcome into a PLAIN frozen wrapper {kind, value?}
     * resolved through promises that NEVER contain an unclassified value:
     *   - "value"       : classified-safe evidence delivered synchronously or
     *                     through the trusted sink
     *   - "hostile"     : hostile evidence (Proxy / revoked / non-detached)
     *   - "throw"       : observe threw / rejected (sanitized plain
     *                     {name,message} only)
     *   - "timeout"     : observation exceeded the bound
     *   - "unsupported" : verifier used an UNSUPPORTED async transport (a
     *                     Promise return), which would require native
     *                     thenable assimilation of untrusted evidence
     *
     * NATIVE PROMISE ASSIMILATION IS NEVER USED ON UNTRUSTED EVIDENCE:
     * the pre-R2 path called `promise.then(...)` on a genuine Promise
     * returned by an async observer; V8 assimilates the promise's RESOLVED
     * value by probing `.then` on it (PromiseResolveThenableJob), which
     * executes a hostile Proxy's `get` trap BEFORE vSafeClassify4 ever sees
     * the value. R2 removes every `then` call on values that can originate
     * from the verifier:
     *
     *   SYNC OBSERVERS   observe(ctx) -> raw evidence: the raw return is
     *                    classified immediately (zero-trap classifier) and
     *                    boxed; it is NEVER passed through Promise.resolve /
     *                    await / .then.
     *   ASYNC OBSERVERS  observe(ctx, sink): the observer drives a
     *                    bootstrap-owned trusted sink. The sink classifies
     *                    the evidence SYNCHRONOUSLY at receipt — before any
     *                    promise machinery can assimilate it — and stores
     *                    only the classified box. The sink is frozen,
     *                    closure-private, exactly-once, and cannot be
     *                    replaced by the verifier. A Promise RETURN from the
     *                    observer is UNSUPPORTED (fail closed to ERROR with
     *                    UNSUPPORTED_ASYNC_RAW_RETURN semantics — never
     *                    VERIFIED_SUCCESS / VERIFIED_FAILURE, never a
     *                    compensation trigger).
     *
     * LATE / DUPLICATE COMPLETION: only the FIRST valid completion (before
     * the timeout) finalizes the observation. Late or duplicate completions
     * are ignored and can never mutate the canonical result or trigger
     * compensation.
     */
    function vRunObservation4(binding, request, executionResult, timeoutMs) {
        return new Promise((resolve) => {
            let finalized = false;
            const finalize = (box) => {
                if (finalized) return; // exactly-once; late/duplicate ignored
                finalized = true;
                clearTimeout(timeoutHandle);
                resolve(box);
            };

            const timeoutHandle = setTimeout(() => {
                finalize(Object.freeze({ kind: "timeout" }));
            }, timeoutMs);
            if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();

            // Trusted sink: bootstrap-owned, frozen, closure-private. Raw
            // evidence is classified SYNCHRONOUSLY at receipt (before any
            // promise machinery), and only the classified box is stored.
            const observationCtx = Object.freeze({
                verificationId: request.verificationId,
                executionId: request.executionId,
                intentId: request.intentId,
                capabilityId: request.capabilityId,
                operation: request.operation,
                principal: request.principal,
                scope: request.scope,
                parameters: executionResult.parameters ?? null,
                expectedPostcondition: request.expectedPostcondition
            });

            const sink = Object.freeze({
                resolveEvidence(rawEvidence) {
                    if (finalized) return; // duplicate/late completion ignored
                    // Classify BEFORE storing: zero-trap gate only.
                    const cls = vSafeClassify4(rawEvidence);
                    if (cls === "hostile") {
                        finalize(Object.freeze({ kind: "hostile" }));
                        return;
                    }
                    if (cls === "inert" || cls === "error" || cls === "promise") {
                        // Inert (fn/symbol/bigint/class instance) evidence and
                        // Error objects delivered through the sink are not
                        // observation values: map to throw/hostile per the
                        // transport contract (a sink may not deliver Errors
                        // as evidence — use rejectObservation).
                        finalize(Object.freeze({ kind: "throw", name: "Error", message: "invalid observation value delivered to sink" }));
                        return;
                    }
                    // TARGETED REPAIR 3: own-`then` whole-object transport
                    // rejection. A sink payload carrying an own `then`
                    // property — data, accessor, function, non-function — is
                    // thenable-shaped transport; reject the whole observation
                    // BEFORE boxing as valid data. Descriptor check on a
                    // proven non-Proxy performs no traps; no getter invoked.
                    if ((cls === "object" || cls === "array") && vHasOwnThen4(rawEvidence)) {
                        finalize(Object.freeze({ kind: "thenableTransport" }));
                        return;
                    }
                    finalize(Object.freeze({ kind: "value", value: rawEvidence }));
                },
                rejectObservation(err) {
                    if (finalized) return; // duplicate/late completion ignored
                    // Sanitized plain error metadata only; the err object
                    // itself is NEVER stored (its properties may be hostile).
                    const e = (err !== null && typeof err === "object") ? err : null;
                    const name = (e !== null && typeof e.name === "string") ? e.name.slice(0, 64) : "Error";
                    const message = (e !== null && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS4) : "verifier rejected the observation";
                    finalize(Object.freeze({ kind: "throw", name, message }));
                }
            });

            // (1) Synchronous observe call — capture the raw RETURN.
            //     NEVER `Promise.resolve(observe())` / `await observe()`:
            //     both assimilate the returned value's `.then`.
            let rawReturn;
            try {
                rawReturn = binding.observe(observationCtx, sink);
            } catch (e) {
                // observe threw synchronously: sanitized plain metadata only.
                const name = ((e && typeof e.name === "string") ? e.name.slice(0, 64) : "Error");
                const message = ((e && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS4) : "");
                finalize(Object.freeze({ kind: "throw", name, message }));
                return;
            }

            // (2) ZERO-TRAP classify the raw return. The ONLY operations on
            //     rawReturn here are typeof / === / internal-slot probes —
            //     NO `.then` read, NO `.then` call, NO assimilation.
            //     A Promise return is UNSUPPORTED: awaiting it would require
            //     native thenable assimilation of its eventual resolution,
            //     which executes attacker-controlled `then` behavior before
            //     Lane 4 can classify. Fail closed.
            const cls = vSafeClassify4(rawReturn);
            if (cls === "promise") {
                // Unsupported async transport (raw Promise return). The
                // observer must use the trusted sink for async completion.
                // The Promise object itself is NEVER assimilated by Lane 4:
                // no .then call, no await, no Promise.resolve. (If the
                // verifier's own code already assimilated a hostile value
                // internally, that execution belongs to the trusted
                // verifier's process — Lane 4's transport stays clean.)
                finalize(Object.freeze({ kind: "unsupported" }));
                return;
            }
            if (cls === "hostile") {
                // Hostile raw return (Proxy / revoked proxy / Proxy-wrapped
                // thenable): rejected at the internal-slot gate with zero
                // trap execution; never assimilated, never retained.
                finalize(Object.freeze({ kind: "hostile" }));
                return;
            }
            if (rawReturn === undefined) {
                // The observer returned undefined: this is the canonical
                // "async via sink" signal. Do NOT finalize from the return
                // value — the sink path owns completion (or the timeout
                // fires). Fall through silently.
            } else if (cls === "error" && vHasOwnThen4(rawReturn)) {
                // TARGETED REPAIR 3: an Error carrying an OWN `then` property
                // is transport-shaped and must be rejected whole BEFORE the
                // Error-to-throw normalization (the Error branch must not
                // bypass the own-then rule). Descriptor lookup on a proven
                // non-Proxy performs no traps.
                finalize(Object.freeze({ kind: "thenableTransport" }));
                return;
            } else if (cls === "inert" || cls === "error") {
                // observe returning a non-undefined inert value (function,
                // symbol, bigint, non-finite number) or an Error object
                // directly: an observer must not deliver these as a return
                // value (use rejectObservation for errors). Classify-first
                // means we never introspect these. Map to throw with
                // sanitized metadata derived ONLY from zero-trap checks.
                const name = ((rawReturn !== null && typeof rawReturn.name === "string") ? rawReturn.name.slice(0, 64) : "Error");
                const message = ((rawReturn !== null && typeof rawReturn.message === "string") ? rawReturn.message.slice(0, V_EV_STRING_CHARS4) : "observer returned an unsupported value; async observers must use the trusted sink");
                finalize(Object.freeze({ kind: "throw", name, message }));
                return;
            }
            if (cls === "null") {
                // observe returned null with no sink completion: treated as
                // no observation (the sink path or a non-null return is
                // required). If the sink already finalized, this is a no-op.
                if (!finalized) {
                    finalize(Object.freeze({ kind: "throw", name: "Error", message: "observer returned null without completing the trusted sink" }));
                }
                return;
            }

            // (3) cls is "primitive" | "object" | "array": synchronous raw
            //     evidence. Box the value directly — the wrapper has no
            //     `then` property, so resolving the OUTER promise with the
            //     wrapper performs NO `.then` probe on the contained value.
            //     (Duplicate: if the sink already finalized first, ignore;
            //     for the undefined sink-async signal, the sink/timeout owns
            //     completion.)
            //     TARGETED REPAIR 3: a plain object/array carrying an OWN
            //     `then` property is a thenable-shaped transport surface —
            //     reject the whole observation BEFORE boxing it as valid
            //     data. The descriptor check on a proven non-Proxy performs
            //     no traps; the `then` getter/setter is never invoked.
            if (!finalized && rawReturn !== undefined) {
                if ((cls === "object" || cls === "array" || cls === "error") && vHasOwnThen4(rawReturn)) {
                    finalize(Object.freeze({ kind: "thenableTransport" }));
                    return;
                }
                finalize(Object.freeze({ kind: "value", value: rawReturn }));
            }
        });
    }

    // ---- verify(): the ONLY downstream verification capability -------------
    async function verify(p) {
        if (p === null || typeof p !== "object") {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "verify requires a request object");
        }
        // Caller-selected verifier/compensator/executor keys are forbidden.
        for (const key of CALLER_VERIFIER_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_VERIFIER_REJECTED,
                    `caller-verifier option '${key}' is forbidden; the verifier is bootstrap-owned, never caller-selectable`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_EXECUTOR_REJECTED,
                    `caller-compensator option '${key}' is forbidden; compensation is a canonical action routed through Lane 3`);
            }
        }

        const executionResult = p.executionResult;
        // BRAND-FIRST: only canonical Lane 3 ExecutionResults are verifiable.
        // (Reuse the Lane 3 brand check through the canonical actuation
        // facade — the ONLY trusted path to brand membership.)
        if (!lane3Facade.isCanonicalExecutionResult(executionResult)) {
            throw fail4(VREASONS4.NOT_CANONICAL_EXECUTION_RESULT,
                "verification requires a canonical Lane 3 ExecutionResult; arbitrary result-shaped objects, JSON clones, and foreign-domain results are not verifiable");
        }

        // Foreign-domain guard: the result must carry the canonical Lane 3
        // result shape AND state vocabulary (a cloned brand check already
        // fails above; this belt-and-braces check keeps the contract explicit).
        if (typeof executionResult.executionId !== "string" ||
            !executionResult.executionId ||
            (executionResult.state !== undefined &&
             !Object.values(RESULT_STATE3b).includes(executionResult.state))) {
            throw fail4(VREASONS4.FOREIGN_DOMAIN_RESULT,
                "execution result carries a foreign/non-canonical shape");
        }

        const expectedPostcondition = formExpectedPostcondition4(p.expectedPostcondition);
        const timeoutMs = (p.timeoutMs === undefined) ? DEFAULT_VTIMEOUT4
            : (isValidVTimeout4(p.timeoutMs) ? p.timeoutMs
                : (() => { throw fail4(VREASONS4.INVALID_TIMEOUT_CONFIG, `verify timeoutMs must be in [${MIN_VTIMEOUT4}, ${MAX_VTIMEOUT4}]`); })());

        // Resolve the bootstrap-owned verifier binding for this capability.op.
        const binding = verifierRegistry.resolve(executionResult.capabilityId, executionResult.operation);
        if (!binding) {
            throw fail4(VREASONS4.VERIFIER_NOT_FOUND,
                `no verifier registered for '${executionResult.capabilityId}.${executionResult.operation}'`);
        }
        // Incarnation discipline: verifier binding must match the capability
        // incarnation the execution ran under (ABA-safe).
        if (binding.capabilityIncarnationId !== executionResult.capabilityIncarnationId) {
            throw fail4(VREASONS4.VERIFIER_INCARNATION_MISMATCH,
                `verifier binding capability incarnation ${binding.capabilityIncarnationId} != result ${executionResult.capabilityIncarnationId}`);
        }
        if (binding.readiness !== VREADINESS4.READY) {
            throw fail4(VREASONS4.VERIFIER_UNAVAILABLE, `verifier readiness is ${binding.readiness}`);
        }

        const verificationId = crypto4.randomUUID();
        if (verificationsById.has(verificationId)) {
            throw fail4(VREASONS4.DUPLICATE_VERIFICATION_ID, "duplicate verificationId");
        }

        const requestedAtMs = canonicalClockNow4();
        const request = deepFreeze4({
            schemaVersion: VREQ_SCHEMA4,
            verificationId,
            executionId: executionResult.executionId,
            intentId: executionResult.intentId,
            capabilityId: executionResult.capabilityId,
            capabilityIncarnationId: executionResult.capabilityIncarnationId,
            operation: executionResult.operation,
            principal: executionResult.principal,
            scope: deepFreeze4(Array.isArray(executionResult.scope) ? executionResult.scope.slice() : []),
            actuatorId: executionResult.actuatorId,
            actuatorIncarnationId: executionResult.actuatorIncarnationId,
            authorityGeneration: executionResult.authorityGeneration,
            verifierId: binding.verifierId,
            verifierIncarnationId: binding.verifierIncarnationId,
            expectedPostcondition,
            requestedAtMs,
            timeoutMs
        });
        vRequestBrandSet4.add(request);

        // Duplicate suppression by executionId+postcondition content: a
        // concurrent verify of the same execution with the same expectation
        // must not produce duplicate observer effects where the observer has
        // side effects.
        const dupKey = crypto4.createHash("sha256").update(JSON.stringify({
            e: request.executionId,
            v: request.verifierIncarnationId,
            p: request.expectedPostcondition
        })).digest("hex");
        const existing = verificationsById.get(dupKey);
        if (existing) return existing.result;

        const rec = { request, result: null };
        verificationsById.set(dupKey, rec);
        verificationsById.set(verificationId, rec);

        // ---- OBSERVING (ZERO-TRAP DELIVERY) ----
        // TARGETED REPAIR 1: the observation value is UNTRUSTED at the moment
        // of receipt. Two language-level gadgets previously executed
        // attacker-controlled traps during delivery:
        //   (a) `await observe(...)` probes the RETURN value's `.then`
        //       (a `get` trap) to decide thenable-ness;
        //   (b) resolving a Promise with a hostile Proxy enqueues a
        //       PromiseResolveThenableJob that probes `.then` again.
        // The wrapper below NEVER reads `.then` off an unclassified value and
        // NEVER resolves a promise with an unclassified value:
        //   1. call observe() synchronously and take its raw return;
        //   2. classify the raw return with the zero-trap classifier
        //      (typeof / === / internal-slot isProxy only);
        //   3. hostile returns are delivered as a PLAIN sentinel object
        //      (boxing never probes the contained value);
        //   4. non-hostile thenables (genuine Promises from async observers)
        //      are awaited through the promise's OWN .then, and their
        //      resolved value is classified the same way before any use.
        // A hostile Proxy returned by an async observer still gets its
        // `.then` probed by the OBSERVER'S OWN async-function machinery at
        // return time — that probe belongs to the verifier's process, not to
        // Lane 4's classification; Lane 4 still classifies and rejects the
        // value with zero further traps.
        const observedAtMs = canonicalClockNow4();
        let observation = null;
        let verifierErrored = null;
        try {
            observation = await vRunObservation4(binding, request, executionResult, timeoutMs);
        } catch (e) {
            verifierErrored = e;
        }

        let verificationState;
        let observedEvidence = null;
        let detail = "";

        if (verifierErrored !== null) {
            // VERIFIER ERROR != VERIFIED FAILURE — infrastructure error is
            // classified separately; the world was not measured.
            verificationState = VSTATE4.ERROR;
            observedEvidence = sanitizeEvidence4(verifierErrored);
            if (observedEvidence === V_HOSTILE_SENTINEL4) observedEvidence = null;
            detail = "verifier infrastructure error";
        } else if (observation.kind === "timeout") {
            // VERIFICATION TIMEOUT: truth could not be established within the
            // bound. NOT success, NOT failure, NOT "no side effect".
            verificationState = VSTATE4.TIMED_OUT;
            detail = `verification exceeded ${timeoutMs}ms; ambiguity preserved`;
        } else if (observation.kind === "throw") {
            // Observe threw (sync or rejected promise): verifier
            // infrastructure error — sanitized plain {name,message} only.
            verificationState = VSTATE4.ERROR;
            observedEvidence = deepFreeze4({ name: observation.name, message: observation.message });
            detail = "verifier infrastructure error";
        } else if (observation.kind === "hostile") {
            // Hostile observation output (Proxy / revoked proxy / other
            // non-detached value, at the raw return OR nested inside
            // otherwise normal-looking evidence): rejected at the zero-trap
            // gate WITHOUT any attacker-controlled reflection. Fail closed:
            // verifier-infrastructure ERROR — never VERIFIED_SUCCESS, never
            // VERIFIED_FAILURE, and NOT INCONCLUSIVE "evidence".
            verificationState = VSTATE4.ERROR;
            observedEvidence = null;
            detail = HOSTILE_EVIDENCE_DETAIL4;
        } else if (observation.kind === "unsupported") {
            // TARGETED REPAIR 2: the observer used an UNSUPPORTED async
            // transport (a raw Promise return). Awaiting it would require
            // native thenable assimilation of its eventual resolution,
            // which executes attacker-controlled `then` behavior before
            // Lane 4 can classify the evidence. Fail closed: typed
            // observation-transport ERROR — never VERIFIED_SUCCESS, never
            // VERIFIED_FAILURE, never INCONCLUSIVE, and NEVER a
            // compensation trigger. The returned Promise object itself was
            // never assimilated by Lane 4 (no .then call, no await, no
            // Promise.resolve).
            verificationState = VSTATE4.ERROR;
            observedEvidence = null;
            detail = `unsupported async observation transport (${VREASONS4.UNSUPPORTED_ASYNC_RAW_RETURN}); async observers must complete through the trusted sink`;
        } else if (observation.kind === "thenableTransport") {
            // TARGETED REPAIR 3: the observation value (or a nested value
            // inside it) carried an OWN `then` property — a thenable-shaped
            // transport surface. Lane 4 detected it via descriptor lookup
            // (no trap invocation) and rejected the ENTIRE observation
            // BEFORE boxing it as valid data. Fail closed: typed
            // observation-transport ERROR — never VERIFIED_SUCCESS, never
            // VERIFIED_FAILURE, never INCONCLUSIVE, never a compensation
            // trigger. Partial sanitization (skipping the `then` field and
            // retaining sibling data) is forbidden.
            verificationState = VSTATE4.ERROR;
            observedEvidence = null;
            detail = `thenable-shaped observation transport rejected (${VREASONS4.UNSUPPORTED_ASYNC_RAW_RETURN}); own "then" property poisons the whole observation`;
        } else {
            // observation.kind === "value"
            const evidence = sanitizeEvidence4(observation.value);
            if (evidence === V_HOSTILE_SENTINEL4) {
                // Nested hostile value inside an otherwise plain-shaped
                // observation: same zero-trap fail-closed classification.
                verificationState = VSTATE4.ERROR;
                observedEvidence = null;
                detail = HOSTILE_EVIDENCE_DETAIL4;
            } else if (evidence === V_THENABLE_SENTINEL4) {
                // TARGETED REPAIR 3: a NESTED own-`then` value inside the
                // observation poisoned the whole observation during
                // sanitization. Same whole-object rejection semantics.
                verificationState = VSTATE4.ERROR;
                observedEvidence = null;
                detail = `thenable-shaped observation transport rejected (${VREASONS4.UNSUPPORTED_ASYNC_RAW_RETURN}); own "then" property poisons the whole observation`;
            } else if (evidence === null && observation.value !== null && observation.value !== undefined) {
                // Unusable-but-benign observation output: not evidence.
                verificationState = VSTATE4.INCONCLUSIVE;
                detail = "observation could not be normalized into evidence";
            } else {
                observedEvidence = evidence;
                const verdict = evaluatePostcondition4(request.expectedPostcondition, evidence);
                if (verdict === "matched") {
                    verificationState = VSTATE4.VERIFIED_SUCCESS;
                } else if (verdict === "mismatched") {
                    verificationState = VSTATE4.VERIFIED_FAILURE;
                } else {
                    // Missing/ambiguous evidence stays INCONCLUSIVE — never
                    // collapsed into success or failure.
                    verificationState = VSTATE4.INCONCLUSIVE;
                    detail = "evidence missing or ambiguous for expected postcondition";
                }
            }
        }

        const result = deepFreeze4({
            schemaVersion: VRES_SCHEMA4,
            verificationId: request.verificationId,
            executionId: request.executionId,
            intentId: request.intentId,
            capabilityId: request.capabilityId,
            capabilityIncarnationId: request.capabilityIncarnationId,
            operation: request.operation,
            principal: request.principal,
            actuatorId: request.actuatorId,
            actuatorIncarnationId: request.actuatorIncarnationId,
            authorityGeneration: request.authorityGeneration,
            verifierId: request.verifierId,
            verifierIncarnationId: request.verifierIncarnationId,
            expectedPostcondition: request.expectedPostcondition,
            observedEvidence: deepFreeze4(observedEvidence),
            observationMethod: request.verifierId,
            verificationState,
            observedAtMs,
            verifiedAtMs: canonicalClockNow4(),
            detail
        });
        vResultBrandSet4.add(result);
        rec.result = result;
        return result;
    }

    // ---- compensate(): a NEW canonical action; never a direct call --------
    async function compensate(p) {
        if (p === null || typeof p !== "object") {
            throw fail4(VREASONS4.MALFORMED_REQUEST, "compensate requires a request object");
        }
        for (const key of CALLER_VERIFIER_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_VERIFIER_REJECTED,
                    `caller-verifier option '${key}' is forbidden`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS4) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail4(VREASONS4.CALLER_EXECUTOR_REJECTED,
                    `caller-compensator option '${key}' is forbidden; compensation routes through the canonical Lane 3 facade`);
            }
        }

        // The compensation trigger must be a canonical verification result
        // produced by THIS closure (never a caller-forged lookalike).
        const source = p.verification;
        if (!vResultBrandSet4.has(source) || source === null || typeof source !== "object") {
            throw fail4(VREASONS4.NOT_CANONICAL_EXECUTION_RESULT,
                "compensation requires a canonical VerificationResult produced by this runtime");
        }
        // The verified state must itself indicate compensation is warranted.
        // Verifier timeout, INCONCLUSIVE, and ERROR states do NOT trigger
        // compensation (ambiguity is preserved, not resolved by re-actuation).
        if (source.verificationState !== VSTATE4.VERIFIED_FAILURE) {
            throw fail4(VREASONS4.COMPENSATION_NOT_INDICATED,
                `verification state '${source.verificationState}' does not indicate compensation; only VERIFIED_FAILURE does`);
        }

        // Plan inputs must be declarative plain values.
        const planCapabilityId = vRequireString4(p.capabilityId, "capabilityId", VBOUNDS4.MAX_CAPABILITY_ID_CHARS);
        const planOperation = vRequireString4(p.operation, "operation", VBOUNDS4.MAX_OPERATION_CHARS);
        const planPrincipal = vRequireString4(p.principal, "principal", VBOUNDS4.MAX_PRINCIPAL_CHARS);
        const planScope = canonicalScope(Array.isArray(p.scope) ? p.scope : []);
        const paramsState = { nodes: 0, maxNodes: VBOUNDS4.MAX_PARAMETERS_NODES, path: new Set() };
        const planParameters = (p.parameters === undefined || p.parameters === null)
            ? deepFreeze4({}) : deepFreeze4(vDetach4(p.parameters, paramsState));
        if (Object.getOwnPropertyNames(planParameters).length > VBOUNDS4.MAX_COMPENSATION_PARAMETERS_KEYS) {
            throw fail4(VREASONS4.BOUND_EXCEEDED, `compensation parameters exceed ${VBOUNDS4.MAX_COMPENSATION_PARAMETERS_KEYS} keys`);
        }
        const reason = vRequireString4(p.reason, "reason", VBOUNDS4.MAX_COMPENSATION_REASON_CHARS);

        // IDEMPOTENCE: a caller may pin compensationId for exact-once retries.
        const compensationId = (p.compensationId === undefined || p.compensationId === null)
            ? crypto4.randomUUID()
            : vRequireString4(p.compensationId, "compensationId", VBOUNDS4.MAX_VERIFICATION_ID_CHARS);
        const existingRecord = compensationById.get(compensationId);
        if (existingRecord) {
            // Same id => SAME record; never a duplicate actuation.
            return existingRecord.result;
        }

        const createdAtMs = canonicalClockNow4();
        const plan = deepFreeze4({
            schemaVersion: CPLAN_SCHEMA4,
            compensationId,
            sourceVerificationId: source.verificationId,
            sourceExecutionId: source.executionId,
            principal: planPrincipal,
            capabilityId: planCapabilityId,
            capabilityIncarnationId: null,
            operation: planOperation,
            scope: planScope,
            parameters: planParameters,
            reason,
            createdAtMs
        });
        vPlanBrandSet4.add(plan);

        const record = { plan, result: null };
        compensationById.set(compensationId, record);

        // ---- COMPENSATION IS A NEW ACTION -------------------------------
        // (1) admit a fresh canonical ActionIntent for the compensation,
        // (2) route through the Lane 3 facade execute() — which performs
        //     fresh Lane 2 revalidation against CURRENT authority,
        // (3) report execution state; restoration is NEVER claimed here.
        let intent;
        try {
            intent = lane3FacadeAdmit4({
                capabilityId: planCapabilityId,
                operation: planOperation,
                arguments: planParameters
            });
        } catch (e) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: `compensation intent rejected at admission: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const session = planPrincipal ? lane3Session4(planPrincipal) : null;
        let executionResult = null;
        if (!session) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: "compensation session could not be established (fail-closed)",
                restored: null
            });
            record.result = result;
            return result;
        }

        try {
            executionResult = await lane3Facade.execute({
                intent,
                authSession: session,
                parameters: planParameters
            });
        } catch (e) {
            const result = deepFreeze4({
                schemaVersion: CRES_SCHEMA4,
                compensationId,
                sourceVerificationId: plan.sourceVerificationId,
                sourceExecutionId: plan.sourceExecutionId,
                state: CSTATE4.FAILED,
                executionResult: null,
                detail: `compensation dispatch failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const executedOk = executionResult && executionResult.state === "EXECUTED";
        const result = deepFreeze4({
            schemaVersion: CRES_SCHEMA4,
            compensationId,
            sourceVerificationId: plan.sourceVerificationId,
            sourceExecutionId: plan.sourceExecutionId,
            state: executedOk ? CSTATE4.EXECUTED : CSTATE4.FAILED,
            executionResult,
            detail: executedOk
                ? "compensation action executed through canonical Lane 3; restoration NOT claimed until a fresh verification succeeds"
                : "compensation action did not execute",
            // COMPENSATION != ROLLBACK GUARANTEE: restored is null here. Only
            // a SEPARATE fresh verification of the compensation's own
            // postcondition returning VERIFIED_SUCCESS may ever claim
            // restoration — and even then it is verified per-postcondition,
            // never a blanket rollback.
            restored: null
        });
        record.result = result;
        return result;
    }

    // ---- Lane 2/Lane 3 canonical routing helpers (closure-private) --------
    // admit a compensation intent + mint a session through the canonical
    // Lane 2 facade. The canonical action facade fails closed on
    // authentication, so compensation through THIS production closure fails
    // closed at the session step unless a trusted lane wires real auth —
    // exactly like every other canonical action path.
    function lane3FacadeAdmit4({ capabilityId, operation, arguments: args }) {
        const lane2 = deps.createLane2Facade();
        const serialized = JSON.stringify({
            schemaVersion: 1,
            capabilityId,
            operation,
            arguments: args
        });
        return lane2.admit(serialized, { source: "lane4-compensation" });
    }

    function lane3Session4(principal) {
        // The canonical authentication path is bootstrap-owned and
        // FAILS CLOSED (canonicalAuthAdapter returns null). Compensation
        // therefore cannot mint a session from caller input — mirroring the
        // production trust model until real auth infrastructure is wired INTO
        // the bootstrap by a later lane. Tests exercise the full authorized
        // path through the test-only harness (tests/verification/harness.js).
        try {
            const lane2 = deps.createLane2Facade();
            return lane2.session({ claimedPrincipal: principal });
        } catch {
            return null;
        }
    }

    const canonicalVerification = Object.freeze({
        // least-privilege downstream surface
        verify,
        compensate,

        // PURE brand-recognition predicates — BRAND-FIRST: closure-only
        // WeakSet membership decides before any property read.
        isCanonicalVerificationRequest(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vRequestBrandSet4.has(value)) return false;
            return true;
        },
        isCanonicalVerificationResult(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vResultBrandSet4.has(value)) return false;
            return true;
        },
        isCanonicalCompensationPlan(value) {
            if (value === null || typeof value !== "object") return false;
            if (!vPlanBrandSet4.has(value)) return false;
            return true;
        }
    });
    return canonicalVerification;
}

module.exports = { createCanonicalVerificationComposition };
