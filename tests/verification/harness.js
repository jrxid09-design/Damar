"use strict";

/**
 * ACTION VERIFICATION + COMPENSATION FABRIC V1 — TEST-ONLY VERIFICATION
 * HARNESS (mirrors the certified Lane 3 actuation harness pattern).
 *
 * Production src/action/verification/*.js export ONLY inert vocabulary + pure
 * predicates — the privileged constructors (verifier registry, formers,
 * evaluator, sanitizer, compensation dispatcher) live ONLY in the trusted
 * bootstrap's private lexical closure (src/action/bootstrap.js). Tests cannot
 * import them from production; this harness owns its OWN private copies of the
 * same implementation (the test-domain analogue of the trusted bootstrap
 * closure) and is reachable ONLY under tests/ (production src/** never
 * imports it).
 *
 * The test harness composes the canonical verification path over TEST-DOMAIN
 * canonical Lane 3 ExecutionResults — produced by tests/actuation/harness.js
 * against ITS closure-private brand. The harness's private formers brand their
 * outputs against this harness's OWN closure-private brand WeakSets, exactly
 * mirroring how the production trusted bootstrap brands against ITS
 * closure-private WeakSets. The public production brand predicates live as
 * methods on createCanonicalVerificationFacade() (which tests can also
 * exercise directly to prove hostile-input safety on the real predicates).
 *
 * The trusted test harness owns:
 *   - test verifier registry + registrar (test-owned, never reachable from src/action)
 *   - test verification request/result/plan formers (private copies)
 *   - test postcondition former/evaluator (private copies)
 *   - test evidence sanitizer (private copy)
 *   - test compensation dispatcher that routes through the actuation harness's
 *     execute() — exactly mirroring the production "compensation is a new
 *     Lane 3 action" path
 *
 * Downstream test code receives ONLY { verify, compensate } + the brand
 * predicates — exactly like production.
 */

const crypto = require("node:crypto");
const {
    VERIFICATION_STATE, COMPENSATION_STATE, LIFECYCLE, REASONS, fail
} = require("../../src/action/verification/errors");
const {
    POSTCONDITION_OPS, POSTCONDITION_KIND, POSTCONDITION_SCHEMA_VERSION,
    isValidPostconditionPath
} = require("../../src/action/verification/postcondition");
const {
    VERIFICATION_REQUEST_SCHEMA_VERSION,
    VERIFICATION_RESULT_SCHEMA_VERSION,
    COMPENSATION_PLAN_SCHEMA_VERSION,
    COMPENSATION_RESULT_SCHEMA_VERSION,
    BOUNDS,
    DEFAULT_VERIFY_TIMEOUT_MS,
    MIN_VERIFY_TIMEOUT_MS,
    MAX_VERIFY_TIMEOUT_MS,
    isValidVerifyTimeoutMs
} = require("../../src/action/verification/schema");
const { READINESS } = require("../../src/action/verification/verifierRegistry");
const { makeActuationHarness } = require("../actuation/harness");
const { canonicalScope } = require("../../src/action/intent");

// ---------------------------------------------------------------------------
// TEST-ONLY PRIVATE IMPLEMENTATION COPIES (mirror the production trusted
// bootstrap's private Lane 4 closure)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
    // Called ONLY on values already classified Proxy-free by safeClassify
    // (see the zero-trap trust-ordering note there).
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

// ---------------------------------------------------------------------------
// ZERO-TRAP HOSTILE CLASSIFICATION (TARGETED REPAIR 1 — test-domain mirror of
// the production closure's vSafeClassify4).
//
// ROOT CAUSE mirrored: detach()/sanitizeEvidence() invoked reflection
// (instanceof Error, getPrototypeOf, ownKeys, descriptors) on UNCLASSIFIED
// verifier observation values, so a Proxy could execute attacker-controlled
// traps during evidence classification. Post-repair trust ordering —
// SAFE ORIGIN FIRST, REFLECTION SECOND — uses ONLY typeof / === /
// util.types.isProxy() (internal-slot probe, zero traps even for revoked
// proxies) until a value is proven not to be a Proxy. Proxies and other
// exotic objects are rejected BEFORE any reflection; every nested value
// re-enters the gate before its own reflection (the invariant holds
// recursively). No transparent-Proxy acceptance: fail-closed rejection is
// preferred over fragile shape-based trust.
// ---------------------------------------------------------------------------
const { types: utilTypes } = require("node:util");

/**
 * Zero-trap classification of an untrusted value. Returns:
 *   "primitive" | "null" | "error" | "array" | "object" | "hostile"
 * Uses only typeof/===/internal-slot probes on unclassified values.
 * "hostile" is NOT a world claim: callers map it to fail-closed states.
 */
function safeClassify(value) {
    if (value === null) return "null";
    const t = typeof value;
    if (t === "string" || t === "boolean") return "primitive";
    if (t === "number") return Number.isFinite(value) ? "primitive" : "inert";
    // function/symbol/bigint/undefined are INERT: droppable in evidence,
    // rejected in postcondition/parameter payloads.
    if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") return "inert";
    if (t !== "object") return "hostile";
    // THE GATE: internal-slot proxy probe (zero traps, zero throws).
    if (utilTypes.isProxy(value)) return "hostile";
    if (Array.isArray(value)) {
        return Object.getPrototypeOf(value) === Array.prototype ? "array" : "hostile";
    }
    // A genuine Promise is a trusted native delivery object: classify it so
    // the observation runner can await it WITHOUT probing `.then` on an
    // unclassified value. util.types.isPromise is an internal-slot probe
    // (zero traps). A Proxy wrapping a Promise reports false and is rejected
    // as "hostile" at the gate.
    if (utilTypes.isPromise(value)) return "promise";
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return "object";
    // static Error prototype chain — NOT instanceof (no HasInstance gadget)
    let cursor = proto;
    for (let hops = 0; hops < 8 && cursor !== null; hops++) {
        if (cursor === Error.prototype || cursor === globalThis.Error?.prototype) return "error";
        cursor = Object.getPrototypeOf(cursor);
    }
    // Other exotic objects (class instances, Map/Set/Date/RegExp, cross-realm
    // objects): NOT proxies, so own-property reflection is trap-free; the
    // established evidence contract sanitizes them to null ("inert") rather
    // than poisoning. Only actual Proxies poison.
    return "inert";
}

/**
 * PLAIN-THENABLE WHOLE-OBJECT TRANSPORT REJECTION (TARGETED REPAIR 3 —
 * mirrors the production vHasOwnThen4). A non-Proxy object/array carrying
 * an OWN `then` property (data, accessor, function, non-function,
 * undefined, null) is a thenable-shaped transport surface: reject whole.
 * Descriptor lookup only — no duck typing, no getter/setter invocation.
 * The caller must have already classified the value as non-Proxy.
 */
function hasOwnThen(v) {
    return Object.getOwnPropertyDescriptor(v, "then") !== undefined;
}

function detach(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) throw fail(REASONS.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    // ZERO-TRAP GATE: classification before any reflection.
    const cls = safeClassify(value);
    if (cls === "null") return null;
    if (cls === "primitive") return value;
    if (cls === "inert") {
        const t = typeof value;
        if (t === "function") throw fail(REASONS.FUNCTION_VALUE, "function values are not permitted");
        throw fail(REASONS.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (cls === "hostile") {
        throw fail(REASONS.NON_PLAIN_OBJECT, "proxy-like or non-plain value is not permitted (zero-trap fail-closed)");
    }
    // TARGETED REPAIR 3: own-`then` whole-input rejection for
    // postcondition/compensation-parameter payloads (consistent with the
    // observation transport rule). Descriptor lookup only; no getter.
    if (cls === "object" || cls === "array" || cls === "error") {
        if (hasOwnThen(value)) {
            throw fail(REASONS.UNSUPPORTED_ASYNC_RAW_RETURN,
                "thenable-shaped input is not permitted (own \"then\" property rejected whole)");
        }
    }
    // cls is "array" | "object" — reflection is now safe.
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > BOUNDS.GLOBAL_MAX_ARRAY_LENGTH) throw fail(REASONS.BOUND_EXCEEDED, "array length exceeds global bound");
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = detach(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!isPlainObject(value)) throw fail(REASONS.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (DANGEROUS_KEYS.has(key)) throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) throw fail(REASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        out[key] = detach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw fail(REASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    state.path.delete(value);
    return out;
}

function requireString(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail(REASONS.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") throw fail(REASONS.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) throw fail(REASONS.MALFORMED_REQUEST, `${field} must not be empty`);
    if (s.length > maxChars) throw fail(REASONS.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    return s;
}

function requireSafeInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail(REASONS.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

function formExpectedPostcondition(raw) {
    if (raw === undefined || raw === null) throw fail(REASONS.MALFORMED_REQUEST, "expectedPostcondition is required");
    if (typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint") {
        throw fail(REASONS.EXECUTABLE_POSTCONDITION_REJECTED, "expected postcondition must be declarative; executable values are rejected");
    }
    // ZERO-TRAP REPAIR: classify FIRST (typeof/===/internal-slot probes only).
    // Any Proxy — trap-bearing or transparent — is rejected here with zero
    // traps; the old ownKeys-vs-enumerable divergence probe ran reflection on
    // unclassified values and was itself a trap gadget, so it is removed.
    if (safeClassify(raw) !== "object") {
        throw fail(REASONS.NON_PLAIN_OBJECT, "proxy-like or non-plain postcondition is not permitted (zero-trap fail-closed)");
    }
    // raw is now a genuinely plain object: reflection is safe.
    if (!isPlainObject(raw)) throw fail(REASONS.NON_PLAIN_OBJECT, "expected postcondition must be a plain declarative object");
    let detached;
    try {
        const state = { nodes: 0, maxNodes: BOUNDS.MAX_PARAMETERS_NODES, path: new Set() };
        detached = detach(raw, state);
    } catch (e) {
        if (e && typeof e.reasonCode === "string") throw e;
        throw fail(REASONS.NON_PLAIN_OBJECT, "hostile postcondition object rejected during detachment");
    }
    return finishExpectedPostcondition(detached);
}

function finishExpectedPostcondition(detached) {
    if (detached.schemaVersion !== undefined && detached.schemaVersion !== POSTCONDITION_SCHEMA_VERSION) {
        throw fail(REASONS.MALFORMED_REQUEST, `unsupported postcondition schemaVersion ${JSON.stringify(detached.schemaVersion)}`);
    }
    if (detached.kind !== undefined && detached.kind !== POSTCONDITION_KIND) {
        throw fail(REASONS.MALFORMED_REQUEST, `unsupported postcondition kind ${JSON.stringify(detached.kind)}`);
    }
    const expect = {};
    let expectCount = 0;
    if (detached.expect !== undefined && detached.expect !== null) {
        if (!isPlainObject(detached.expect)) throw fail(REASONS.MALFORMED_REQUEST, "postcondition expect must be a plain object");
        for (const [path, rule] of Object.entries(detached.expect)) {
            expectCount++;
            if (expectCount > BOUNDS.MAX_EXPECT_ENTRIES) throw fail(REASONS.BOUND_EXCEEDED, `postcondition expect exceeds ${BOUNDS.MAX_EXPECT_ENTRIES} entries`);
            if (!isValidPostconditionPath(path)) throw fail(REASONS.DANGEROUS_KEY, `invalid postcondition path '${String(path).slice(0, 64)}'`);
            if (!isPlainObject(rule)) throw fail(REASONS.MALFORMED_REQUEST, `postcondition rule for '${path}' must be a declarative object`);
            const op = rule.op;
            if (!Object.values(POSTCONDITION_OPS).includes(op)) throw fail(REASONS.MALFORMED_REQUEST, `postcondition rule for '${path}' has invalid op`);
            const ruleOut = { op };
            if ("value" in rule) {
                const valueState = { nodes: 0, maxNodes: BOUNDS.MAX_VALUE_NODES, path: new Set() };
                ruleOut.value = detach(rule.value, valueState);
            }
            expect[path] = Object.freeze(ruleOut);
        }
    }
    const forbid = {};
    let forbidCount = 0;
    if (detached.forbid !== undefined && detached.forbid !== null) {
        if (!isPlainObject(detached.forbid)) throw fail(REASONS.MALFORMED_REQUEST, "postcondition forbid must be a plain object");
        for (const [path, value] of Object.entries(detached.forbid)) {
            forbidCount++;
            if (forbidCount > BOUNDS.MAX_EXPECT_ENTRIES) throw fail(REASONS.BOUND_EXCEEDED, `postcondition forbid exceeds ${BOUNDS.MAX_EXPECT_ENTRIES} entries`);
            if (!isValidPostconditionPath(path)) throw fail(REASONS.DANGEROUS_KEY, `invalid postcondition forbid path '${String(path).slice(0, 64)}'`);
            const valueState = { nodes: 0, maxNodes: BOUNDS.MAX_VALUE_NODES, path: new Set() };
            forbid[path] = detach(value, valueState);
        }
    }
    if (expectCount === 0 && forbidCount === 0) {
        throw fail(REASONS.MALFORMED_REQUEST, "expected postcondition must contain at least one expect or forbid rule (vacuous postconditions are rejected)");
    }
    return deepFreeze({ schemaVersion: POSTCONDITION_SCHEMA_VERSION, kind: POSTCONDITION_KIND, expect: deepFreeze(expect), forbid: deepFreeze(forbid) });
}

function readPath(obj, path) {
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

function evaluatePostcondition(postcondition, evidence) {
    if (!postcondition || typeof postcondition !== "object") return "insufficient";
    const ev = (evidence === null || evidence === undefined || typeof evidence !== "object") ? {} : evidence;
    let sawAny = false;
    for (const [path, rule] of Object.entries(postcondition.expect ?? {})) {
        sawAny = true;
        const { found, value } = readPath(ev, path);
        const op = rule.op;
        if (op === POSTCONDITION_OPS.EXISTS) {
            if (!found) return "insufficient";
            if (value === null || value === undefined) return "mismatched";
            continue;
        }
        if (op === POSTCONDITION_OPS.ABSENT) {
            if (found && value !== null && value !== undefined) return "mismatched";
            continue;
        }
        if (op === POSTCONDITION_OPS.IN) {
            if (!found) return "insufficient";
            const options = Array.isArray(rule.value) ? rule.value : [];
            if (!options.some((o) => o === value)) return "mismatched";
            continue;
        }
        if (op === POSTCONDITION_OPS.TYPE) {
            if (!found) return "insufficient";
            const t = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
            if (t !== rule.value) return "mismatched";
            continue;
        }
        if (!found) return "insufficient";
        if (op === POSTCONDITION_OPS.EQ) { if (value !== rule.value) return "mismatched"; }
        else if (op === POSTCONDITION_OPS.NE) { if (value === rule.value) return "mismatched"; }
        else if (op === POSTCONDITION_OPS.GT || op === POSTCONDITION_OPS.GTE || op === POSTCONDITION_OPS.LT || op === POSTCONDITION_OPS.LTE) {
            if (typeof value !== "number" || typeof rule.value !== "number") return "mismatched";
            if (op === POSTCONDITION_OPS.GT && !(value > rule.value)) return "mismatched";
            if (op === POSTCONDITION_OPS.GTE && !(value >= rule.value)) return "mismatched";
            if (op === POSTCONDITION_OPS.LT && !(value < rule.value)) return "mismatched";
            if (op === POSTCONDITION_OPS.LTE && !(value <= rule.value)) return "mismatched";
        } else return "insufficient";
    }
    for (const [path, forbiddenValue] of Object.entries(postcondition.forbid ?? {})) {
        sawAny = true;
        const { found, value } = readPath(ev, path);
        // forbid: { path: X } — the path, if present, must not equal X.
        // (To require a path be entirely absent, use
        // expect: { path: { op: "absent" } }.)
        if (found && value === forbiddenValue) return "mismatched";
    }
    if (!sawAny) return "insufficient";
    return "matched";
}

const V_EV_STRING_CHARS = 1024, V_EV_KEYS = 64, V_EV_DEPTH = 8, V_EV_NODES = 512;
// Sentinel returned for hostile values; the caller maps to the
// verifier-infrastructure ERROR state (never a world claim).
const HOSTILE_SENTINEL = Symbol("damar.action.verification.evidence.hostile");
const HOSTILE_EVIDENCE_DETAIL =
    "hostile observation rejected: proxy-like or non-detached value (zero-trap fail-closed)";
// TARGETED REPAIR 3: own-`then` thenable-shaped transport rejection sentinel.
const THENABLE_SENTINEL = Symbol("damar.action.verification.evidence.thenableTransport");
const THENABLE_TRANSPORT_DETAIL =
    "thenable-shaped observation transport rejected: own \"then\" property poisons the whole observation";

function sanitizeEvidence(value) {
    const state = { nodes: 0, path: new Set() };

    function normalizeErrorName(v) {
        let n = v.name; if (typeof n !== "string") n = "Error"; n = n.slice(0, 64);
        let m = v.message; if (typeof m !== "string") m = ""; m = m.slice(0, V_EV_STRING_CHARS);
        return { name: n, message: m };
    }

    function walk(v, depth) {
        state.nodes++;
        if (state.nodes > V_EV_NODES || depth > V_EV_DEPTH) return null;
        // (1) ZERO-TRAP GATE.
        const cls = safeClassify(v);
        if (cls === "null" || cls === "inert") return null;
        if (cls === "primitive") {
            const t = typeof v;
            if (t === "string") return v.length > V_EV_STRING_CHARS ? v.slice(0, V_EV_STRING_CHARS) : v;
            if (t === "boolean") return v;
            return v;
        }
        if (cls === "error") {
            // TARGETED REPAIR 3: an Error with own `then` is transport-shaped
            // and must be rejected whole — the Error branch must not bypass
            // the own-then rule. Descriptor lookup; no getter.
            if (hasOwnThen(v)) return THENABLE_SENTINEL;
            return normalizeErrorName(v);
        }
        if (cls === "hostile") return HOSTILE_SENTINEL;
        // TARGETED REPAIR 3: own-`then` whole-object transport rejection.
        // The value is a non-Proxy plain object/array; descriptor lookup
        // performs no traps; the `then` getter/setter is NEVER invoked.
        if (hasOwnThen(v)) return THENABLE_SENTINEL;
        // cls is "array" | "object" — reflection is now safe.
        if (state.path.has(v)) return null;
        state.path.add(v);
        if (Array.isArray(v)) {
            const out = v.slice(0, 256).map((x) => walk(x, depth + 1));
            state.path.delete(v);
            if (out.some((x) => x === HOSTILE_SENTINEL)) return HOSTILE_SENTINEL;
            if (out.some((x) => x === THENABLE_SENTINEL)) return THENABLE_SENTINEL;
            return out;
        }
        const out = {};
        let keys = 0;
        let poisoned = false;
        let poisonedSentinel = HOSTILE_SENTINEL;
        for (const key of Object.getOwnPropertyNames(v)) {
            if (keys >= V_EV_KEYS) break;
            keys++;
            if (DANGEROUS_KEYS.has(key)) continue;
            const desc = Object.getOwnPropertyDescriptor(v, key);
            if (!desc || desc.get || desc.set) continue;
            const kk = key.length > 128 ? key.slice(0, 128) : key;
            const child = walk(desc.value, depth + 1);
            if (child === HOSTILE_SENTINEL || child === THENABLE_SENTINEL) {
                poisoned = true;
                poisonedSentinel = child;
                break;
            }
            out[kk] = child;
        }
        state.path.delete(v);
        if (poisoned) return poisonedSentinel;
        return out;
    }
    const result = walk(value, 0);
    if (result === HOSTILE_SENTINEL) return HOSTILE_SENTINEL;
    if (result === THENABLE_SENTINEL) return THENABLE_SENTINEL;
    return result;
}

function buildVerifierRegistry() {
    const byId = new Map();
    const byCap = new Map();
    function canonicalOp(op) { return String(op ?? "").trim().toLowerCase(); }
    function register({ capabilityId, operations, capabilityIncarnationId, verifierId, observe, readiness = "READY" }) {
        if (typeof capabilityId !== "string" || capabilityId.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "verifier registration requires a non-empty capabilityId");
        if (!Array.isArray(operations) || operations.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "verifier registration requires a non-empty operations array");
        const ops = operations.map(canonicalOp).filter((s) => s.length > 0);
        if (ops.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "verifier registration requires a non-empty operations array");
        if (typeof capabilityIncarnationId !== "string" || capabilityIncarnationId.length === 0) throw fail(REASONS.REGISTRATION_REJECTED, "verifier registration requires a capabilityIncarnationId");
        if (typeof observe !== "function") throw fail(REASONS.REGISTRATION_REJECTED, "verifier registration requires an observe function");
        if (!READINESS[readiness]) throw fail(REASONS.REGISTRATION_REJECTED, `invalid readiness '${readiness}'`);
        const id = (typeof verifierId === "string" && verifierId.length > 0) ? verifierId : `ver-${crypto.randomUUID()}`;
        const verifierIncarnationId = `vinc-${crypto.randomUUID()}`;
        if (byId.has(id)) throw fail(REASONS.REGISTRATION_REJECTED, `verifier '${id}' is already registered; remove it first`);
        const observeFn = observe.bind({});
        const binding = Object.freeze({ capabilityId, operations: Object.freeze(ops.slice()), capabilityIncarnationId, verifierId: id, verifierIncarnationId, readiness, observe: observeFn });
        byId.set(id, binding);
        let opMap = byCap.get(capabilityId);
        if (!opMap) { opMap = new Map(); byCap.set(capabilityId, opMap); }
        for (const op of ops) {
            if (opMap.has(op)) { byId.delete(id); throw fail(REASONS.REGISTRATION_REJECTED, `verifier already registered for '${capabilityId}.${op}'`); }
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
    function get(verifierId) { return byId.get(verifierId) ?? null; }
    return Object.freeze({ register, remove, resolve, get });
}

// ---- TEST-DOMAIN brand WeakSets (mirror production closure-private brands) ----
const testRequestBrandSet = new WeakSet();
const testResultBrandSet = new WeakSet();
const testPlanBrandSet = new WeakSet();

const CALLER_VERIFIER_KEYS = Object.freeze([
    "verifier", "verifierFn", "observe", "observeFn", "sensor", "sensorFn",
    "predicate", "predicateFn", "evaluator", "evaluatorFn", "checker",
    "checkFn", "postconditionFn", "verifyFn"
]);
const CALLER_COMPENSATOR_KEYS = Object.freeze([
    "compensator", "compensatorFn", "rollback", "rollbackFn", "repair",
    "repairFn", "undo", "undoFn", "restore", "restoreFn", "compensateFn"
]);
const TIMEOUT_SENTINEL = Symbol("damar.action.verification.timeout");

/**
 * ZERO-ASSIMILATION observation runner (TARGETED REPAIR 2 — mirrors the
 * production vRunObservation4).
 *
 * NATIVE PROMISE ASSIMILATION IS NEVER USED ON UNTRUSTED EVIDENCE: the
 * pre-R2 path called `promise.then(...)` on a genuine Promise returned by an
 * async observer; V8 assimilates the promise's RESOLVED value by probing
 * `.then` on it (PromiseResolveThenableJob), which executes a hostile
 * Proxy's `get` trap BEFORE safeClassify ever sees the value. R2 removes
 * every `then` call on values that can originate from the verifier:
 *
 *   SYNC OBSERVERS   observe(ctx) -> raw evidence: classified immediately
 *                    and boxed; NEVER passed through Promise.resolve /
 *                    await / .then.
 *   ASYNC OBSERVERS  observe(ctx, sink): drives a harness-owned trusted
 *                    sink that classifies the evidence SYNCHRONOUSLY at
 *                    receipt. A Promise RETURN is UNSUPPORTED (fail closed
 *                    to ERROR with UNSUPPORTED_ASYNC_RAW_RETURN semantics).
 *
 * LATE / DUPLICATE COMPLETION: only the FIRST valid completion (before the
 * timeout) finalizes the observation; later completions are ignored.
 */
function runObservation(binding, request, executionResult, timeoutMs) {
    return new Promise((resolve) => {
        let finalized = false;
        const finalize = (box) => {
            if (finalized) return;
            finalized = true;
            clearTimeout(timeoutHandle);
            resolve(box);
        };
        const timeoutHandle = setTimeout(() => finalize(Object.freeze({ kind: "timeout" })), timeoutMs);
        if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();

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
                if (finalized) return;
                const cls = safeClassify(rawEvidence);
                if (cls === "hostile") {
                    finalize(Object.freeze({ kind: "hostile" }));
                    return;
                }
                if (cls === "inert" || cls === "error" || cls === "promise") {
                    finalize(Object.freeze({ kind: "throw", name: "Error", message: "invalid observation value delivered to sink" }));
                    return;
                }
                // TARGETED REPAIR 3: own-`then` whole-object transport rejection
                if ((cls === "object" || cls === "array") && hasOwnThen(rawEvidence)) {
                    finalize(Object.freeze({ kind: "thenableTransport" }));
                    return;
                }
                finalize(Object.freeze({ kind: "value", value: rawEvidence }));
            },
            rejectObservation(err) {
                if (finalized) return;
                const e = (err !== null && typeof err === "object") ? err : null;
                const name = (e !== null && typeof e.name === "string") ? e.name.slice(0, 64) : "Error";
                const message = (e !== null && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS) : "verifier rejected the observation";
                finalize(Object.freeze({ kind: "throw", name, message }));
            }
        });

        let rawReturn;
        try {
            rawReturn = binding.observe(observationCtx, sink);
        } catch (e) {
            const name = ((e && typeof e.name === "string") ? e.name.slice(0, 64) : "Error");
            const message = ((e && typeof e.message === "string") ? e.message.slice(0, V_EV_STRING_CHARS) : "");
            finalize(Object.freeze({ kind: "throw", name, message }));
            return;
        }

        // ZERO-TRAP classify the raw return. NO `.then` read, NO `.then`
        // call, NO assimilation. A Promise return is UNSUPPORTED.
        const cls = safeClassify(rawReturn);
        if (cls === "promise") {
            finalize(Object.freeze({ kind: "unsupported" }));
            return;
        }
        if (cls === "hostile") {
            finalize(Object.freeze({ kind: "hostile" }));
            return;
        }
        if (rawReturn === undefined) {
            // async-via-sink signal: do NOT finalize from the return value.
        } else if (cls === "error" && hasOwnThen(rawReturn)) {
            // TARGETED REPAIR 3: Error with own `then` is transport-shaped —
            // reject whole BEFORE Error normalization (no branch bypass).
            finalize(Object.freeze({ kind: "thenableTransport" }));
            return;
        } else if (cls === "inert" || cls === "error") {
            const name = ((rawReturn !== null && typeof rawReturn.name === "string") ? rawReturn.name.slice(0, 64) : "Error");
            const message = ((rawReturn !== null && typeof rawReturn.message === "string") ? rawReturn.message.slice(0, V_EV_STRING_CHARS) : "observer returned an unsupported value; async observers must use the trusted sink");
            finalize(Object.freeze({ kind: "throw", name, message }));
            return;
        }
        if (cls === "null") {
            if (!finalized) {
                finalize(Object.freeze({ kind: "throw", name: "Error", message: "observer returned null without completing the trusted sink" }));
            }
            return;
        }

        // Synchronous plain return: box the value directly (the wrapper has
        // no `then` property, so resolution of the OUTER promise does NOT
        // probe the contained value). For the undefined sink-async signal,
        // the sink/timeout owns completion.
        if (!finalized && rawReturn !== undefined) {
            // TARGETED REPAIR 3: own-`then` whole-object transport rejection
            // BEFORE boxing as valid data. Descriptor lookup on a proven
            // non-Proxy performs no traps; the getter is never invoked.
            if ((cls === "object" || cls === "array" || cls === "error") && hasOwnThen(rawReturn)) {
                finalize(Object.freeze({ kind: "thenableTransport" }));
                return;
            }
            finalize(Object.freeze({ kind: "value", value: rawReturn }));
        }
    });
}

/**
 * Build a Lane 4 test harness:
 *   {
 *     lane3,                // Lane 3 actuation harness (execute + brand predicates)
 *     verify, compensate,
 *     isCanonicalVerificationRequest,
 *     isCanonicalVerificationResult,
 *     isCanonicalCompensationPlan,
 *     registerVerifier, removeVerifier
 *   }
 */
async function makeVerificationHarness({ clock, scopeBindings, authenticate } = {}) {
    const lane3 = await makeActuationHarness({ clock, scopeBindings, authenticate });
    const verifierRegistry = buildVerifierRegistry();
    // Local actuation brand set of the Lane 3 harness this verification
    // harness composes over. Verification is bound to the canonical Lane 3
    // brand — results from a DIFFERENT harness (different trust domain)
    // are rejected by the brand check below.
    const lane3ResultBrand = lane3._localResultBrandSet;

    const verificationsById = new Map();
    const compensationById = new Map();

    function canonicalClockNow() {
        const v = (clock ? clock.nowMs() : Date.now());
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
            throw fail(REASONS.MALFORMED_REQUEST, "canonical clock returned an invalid timestamp");
        }
        return v;
    }

    async function verify(p) {
        if (p === null || typeof p !== "object") throw fail(REASONS.MALFORMED_REQUEST, "verify requires a request object");
        for (const key of CALLER_VERIFIER_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_VERIFIER_REJECTED, `caller-verifier option '${key}' is forbidden; the verifier is bootstrap-owned, never caller-selectable`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED, `caller-compensator option '${key}' is forbidden; compensation is a canonical action routed through Lane 3`);
            }
        }
        const executionResult = p.executionResult;
        // TEST-DOMAIN canonical brand check (mirrors the production brand check).
        if (!lane3ResultBrand.has(executionResult)) {
            throw fail(REASONS.NOT_CANONICAL_EXECUTION_RESULT,
                "verification requires a canonical Lane 3 ExecutionResult; arbitrary result-shaped objects, JSON clones, and foreign-domain results are not verifiable");
        }
        if (typeof executionResult.executionId !== "string" || !executionResult.executionId ||
            (executionResult.state !== undefined && !["EXECUTED", "FAILED", "TIMED_OUT", "CANCELLED"].includes(executionResult.state))) {
            throw fail(REASONS.FOREIGN_DOMAIN_RESULT, "execution result carries a foreign/non-canonical shape");
        }
        const expectedPostcondition = formExpectedPostcondition(p.expectedPostcondition);
        const timeoutMs = (p.timeoutMs === undefined) ? DEFAULT_VERIFY_TIMEOUT_MS
            : (isValidVerifyTimeoutMs(p.timeoutMs) ? p.timeoutMs
                : (() => { throw fail(REASONS.INVALID_TIMEOUT_CONFIG, `verify timeoutMs must be in [${MIN_VERIFY_TIMEOUT_MS}, ${MAX_VERIFY_TIMEOUT_MS}]`); })());

        const binding = verifierRegistry.resolve(executionResult.capabilityId, executionResult.operation);
        if (!binding) throw fail(REASONS.VERIFIER_NOT_FOUND, `no verifier registered for '${executionResult.capabilityId}.${executionResult.operation}'`);
        if (binding.capabilityIncarnationId !== executionResult.capabilityIncarnationId) {
            throw fail(REASONS.VERIFIER_INCARNATION_MISMATCH, `verifier binding capability incarnation ${binding.capabilityIncarnationId} != result ${executionResult.capabilityIncarnationId}`);
        }
        if (binding.readiness !== READINESS.READY) throw fail(REASONS.VERIFIER_UNAVAILABLE, `verifier readiness is ${binding.readiness}`);

        const verificationId = crypto.randomUUID();
        if (verificationsById.has(verificationId)) throw fail(REASONS.DUPLICATE_VERIFICATION_ID, "duplicate verificationId");

        const requestedAtMs = canonicalClockNow();
        const request = deepFreeze({
            schemaVersion: VERIFICATION_REQUEST_SCHEMA_VERSION,
            verificationId,
            executionId: executionResult.executionId,
            intentId: executionResult.intentId,
            capabilityId: executionResult.capabilityId,
            capabilityIncarnationId: executionResult.capabilityIncarnationId,
            operation: executionResult.operation,
            principal: executionResult.principal,
            scope: deepFreeze(Array.isArray(executionResult.scope) ? executionResult.scope.slice() : []),
            actuatorId: executionResult.actuatorId,
            actuatorIncarnationId: executionResult.actuatorIncarnationId,
            authorityGeneration: executionResult.authorityGeneration,
            verifierId: binding.verifierId,
            verifierIncarnationId: binding.verifierIncarnationId,
            expectedPostcondition,
            requestedAtMs,
            timeoutMs
        });
        testRequestBrandSet.add(request);

        const dupKey = crypto.createHash("sha256").update(JSON.stringify({
            e: request.executionId, v: request.verifierIncarnationId, p: request.expectedPostcondition
        })).digest("hex");
        const existing = verificationsById.get(dupKey);
        if (existing) return existing.result;

        const rec = { request, result: null };
        verificationsById.set(dupKey, rec);
        verificationsById.set(verificationId, rec);

        // ---- OBSERVING (ZERO-TRAP DELIVERY — mirrors the production closure) ----
        // The observation value is UNTRUSTED at receipt. The runner never
        // reads `.then` off an unclassified value (a thenable-check would
        // probe a hostile Proxy's get trap) and never resolves a promise with
        // an unclassified value: the raw return is classified FIRST via the
        // internal-slot probe, hostile returns are boxed as a plain sentinel
        // object, and genuine Promises from async observers are awaited via
        // the Promise's own then with re-classification of the resolved value.
        const observedAtMs = canonicalClockNow();
        let observation = null, verifierErrored = null;
        try {
            observation = await runObservation(binding, request, executionResult, timeoutMs);
        } catch (e) { verifierErrored = e; }

        let verificationState, observedEvidence = null, detail = "";
        if (verifierErrored !== null) {
            verificationState = VERIFICATION_STATE.ERROR;
            observedEvidence = sanitizeEvidence(verifierErrored);
            if (observedEvidence === HOSTILE_SENTINEL) observedEvidence = null;
            detail = "verifier infrastructure error";
        } else if (observation.kind === "timeout") {
            verificationState = VERIFICATION_STATE.TIMED_OUT;
            detail = `verification exceeded ${timeoutMs}ms; ambiguity preserved`;
        } else if (observation.kind === "throw") {
            verificationState = VERIFICATION_STATE.ERROR;
            observedEvidence = deepFreeze({ name: observation.name, message: observation.message });
            detail = "verifier infrastructure error";
        } else if (observation.kind === "hostile") {
            verificationState = VERIFICATION_STATE.ERROR;
            observedEvidence = null;
            detail = HOSTILE_EVIDENCE_DETAIL;
        } else if (observation.kind === "unsupported") {
            // TARGETED REPAIR 2: observer used an UNSUPPORTED async transport
            // (raw Promise return). Fail closed to ERROR — never
            // VERIFIED_SUCCESS / VERIFIED_FAILURE / INCONCLUSIVE, never a
            // compensation trigger.
            verificationState = VERIFICATION_STATE.ERROR;
            observedEvidence = null;
            detail = `unsupported async observation transport (${REASONS.UNSUPPORTED_ASYNC_RAW_RETURN}); async observers must complete through the trusted sink`;
        } else if (observation.kind === "thenableTransport") {
            // TARGETED REPAIR 3: observation value (or a nested value) carried
            // an OWN `then` property — thenable-shaped transport. Whole-object
            // rejection before postcondition evaluation.
            verificationState = VERIFICATION_STATE.ERROR;
            observedEvidence = null;
            detail = THENABLE_TRANSPORT_DETAIL;
        } else {
            const evidence = sanitizeEvidence(observation.value);
            if (evidence === HOSTILE_SENTINEL) {
                verificationState = VERIFICATION_STATE.ERROR;
                observedEvidence = null;
                detail = HOSTILE_EVIDENCE_DETAIL;
            } else if (evidence === THENABLE_SENTINEL) {
                // Nested own-`then` poisoned the whole observation.
                verificationState = VERIFICATION_STATE.ERROR;
                observedEvidence = null;
                detail = THENABLE_TRANSPORT_DETAIL;
            } else if (evidence === null && observation.value !== null && observation.value !== undefined) {
                verificationState = VERIFICATION_STATE.INCONCLUSIVE;
                detail = "observation could not be normalized into evidence";
            } else {
                observedEvidence = evidence;
                const verdict = evaluatePostcondition(request.expectedPostcondition, evidence);
                if (verdict === "matched") verificationState = VERIFICATION_STATE.VERIFIED_SUCCESS;
                else if (verdict === "mismatched") verificationState = VERIFICATION_STATE.VERIFIED_FAILURE;
                else { verificationState = VERIFICATION_STATE.INCONCLUSIVE; detail = "evidence missing or ambiguous for expected postcondition"; }
            }
        }

        const result = deepFreeze({
            schemaVersion: VERIFICATION_RESULT_SCHEMA_VERSION,
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
            observedEvidence: deepFreeze(observedEvidence),
            observationMethod: request.verifierId,
            verificationState,
            observedAtMs,
            verifiedAtMs: canonicalClockNow(),
            detail
        });
        testResultBrandSet.add(result);
        rec.result = result;
        return result;
    }

    async function compensate(p) {
        if (p === null || typeof p !== "object") throw fail(REASONS.MALFORMED_REQUEST, "compensate requires a request object");
        for (const key of CALLER_VERIFIER_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_VERIFIER_REJECTED, `caller-verifier option '${key}' is forbidden`);
            }
        }
        for (const key of CALLER_COMPENSATOR_KEYS) {
            if (Object.prototype.hasOwnProperty.call(p, key) && p[key] !== undefined) {
                throw fail(REASONS.CALLER_EXECUTOR_REJECTED, `caller-compensator option '${key}' is forbidden; compensation routes through the canonical Lane 3 facade`);
            }
        }
        const source = p.verification;
        if (!testResultBrandSet.has(source) || source === null || typeof source !== "object") {
            throw fail(REASONS.NOT_CANONICAL_EXECUTION_RESULT, "compensation requires a canonical VerificationResult produced by this runtime");
        }        if (source.verificationState !== VERIFICATION_STATE.VERIFIED_FAILURE) {
            throw fail(REASONS.COMPENSATION_NOT_INDICATED, `verification state '${source.verificationState}' does not indicate compensation; only VERIFIED_FAILURE does`);
        }

        const planCapabilityId = requireString(p.capabilityId, "capabilityId", BOUNDS.MAX_CAPABILITY_ID_CHARS);
        const planOperation = requireString(p.operation, "operation", BOUNDS.MAX_OPERATION_CHARS);
        const planPrincipal = requireString(p.principal, "principal", BOUNDS.MAX_PRINCIPAL_CHARS);
        const planScope = canonicalScope(Array.isArray(p.scope) ? p.scope : []);
        const paramsState = { nodes: 0, maxNodes: BOUNDS.MAX_PARAMETERS_NODES, path: new Set() };
        const planParameters = (p.parameters === undefined || p.parameters === null) ? deepFreeze({}) : deepFreeze(detach(p.parameters, paramsState));
        if (Object.getOwnPropertyNames(planParameters).length > BOUNDS.MAX_COMPENSATION_PARAMETERS_KEYS) {
            throw fail(REASONS.BOUND_EXCEEDED, `compensation parameters exceed ${BOUNDS.MAX_COMPENSATION_PARAMETERS_KEYS} keys`);
        }
        const reason = requireString(p.reason, "reason", BOUNDS.MAX_COMPENSATION_REASON_CHARS);

        const compensationId = (p.compensationId === undefined || p.compensationId === null)
            ? crypto.randomUUID() : requireString(p.compensationId, "compensationId", BOUNDS.MAX_VERIFICATION_ID_CHARS);
        const existingRecord = compensationById.get(compensationId);
        if (existingRecord) return existingRecord.result;

        const createdAtMs = canonicalClockNow();
        const plan = deepFreeze({
            schemaVersion: COMPENSATION_PLAN_SCHEMA_VERSION,
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
        testPlanBrandSet.add(plan);

        const record = { plan, result: null };
        compensationById.set(compensationId, record);

        // COMPENSATION IS A NEW ACTION — route through Lane 3 canonical
        // execute(), which re-validates Lane 2 authority fresh.
        let intent;
        try {
            intent = lane3.lane2.admit(JSON.stringify({
                schemaVersion: 1,
                capabilityId: planCapabilityId,
                operation: planOperation,
                arguments: planParameters
            }), { source: "lane4-compensation" });
        } catch (e) {
            const result = deepFreeze({
                schemaVersion: COMPENSATION_RESULT_SCHEMA_VERSION, compensationId,
                sourceVerificationId: plan.sourceVerificationId, sourceExecutionId: plan.sourceExecutionId,
                state: COMPENSATION_STATE.FAILED, executionResult: null,
                detail: `compensation intent rejected at admission: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const session = lane3.lane2.session(planPrincipal);
        let executionResult = null;
        try {
            executionResult = await lane3.execute({ intent, authSession: session, parameters: planParameters });
        } catch (e) {
            const result = deepFreeze({
                schemaVersion: COMPENSATION_RESULT_SCHEMA_VERSION, compensationId,
                sourceVerificationId: plan.sourceVerificationId, sourceExecutionId: plan.sourceExecutionId,
                state: COMPENSATION_STATE.FAILED, executionResult: null,
                detail: `compensation dispatch failed: ${String(e?.reasonCode ?? e?.message ?? "error").slice(0, 256)}`,
                restored: null
            });
            record.result = result;
            return result;
        }

        const executedOk = executionResult && executionResult.state === "EXECUTED";
        const result = deepFreeze({
            schemaVersion: COMPENSATION_RESULT_SCHEMA_VERSION, compensationId,
            sourceVerificationId: plan.sourceVerificationId, sourceExecutionId: plan.sourceExecutionId,
            state: executedOk ? COMPENSATION_STATE.EXECUTED : COMPENSATION_STATE.FAILED,
            executionResult,
            detail: executedOk
                ? "compensation action executed through canonical Lane 3; restoration NOT claimed until a fresh verification succeeds"
                : "compensation action did not execute",
            restored: null
        });
        record.result = result;
        return result;
    }

    return {
        lane3,
        verify,
        compensate,
        isCanonicalVerificationRequest(value) {
            if (value === null || typeof value !== "object") return false;
            return testRequestBrandSet.has(value);
        },
        isCanonicalVerificationResult(value) {
            if (value === null || typeof value !== "object") return false;
            return testResultBrandSet.has(value);
        },
        isCanonicalCompensationPlan(value) {
            if (value === null || typeof value !== "object") return false;
            return testPlanBrandSet.has(value);
        },
        registerVerifier: verifierRegistry.register,
        removeVerifier: verifierRegistry.remove
    };
}

module.exports = { makeVerificationHarness };
