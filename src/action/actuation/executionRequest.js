"use strict";

/**
 * ACTION ACTUATION FABRIC V1 — canonical ExecutionRequest formation (Lane 3).
 *
 * An ExecutionRequest is the IMMUTABLE canonical binding between a (revalidated
 * at-formation) canonical ActionIntent + authenticated principal + capability
 * incarnation + canonical scope + authority generation and the actuation that
 * will (if dispatch survives pre-actuation revalidation) be performed.
 *
 * CORE LAW: AUTHORITY DECISION IS HISTORICAL EVIDENCE, NOT A BEARER TOKEN.
 * The ExecutionRequest is bound at formation time to the canonical truth
 * OBSERVED at formation; before dispatch the dispatcher MUST revalidate that
 * the same canonical truth still holds. The executionId is NOT a bearer
 * execution token.
 *
 * TRUST ORIGIN: an ExecutionRequest is created ONLY by the trusted dispatcher
 * (src/action/actuation/dispatcher.js), inside the trusted bootstrap's
 * private composition closure. It is NOT a public factory.
 *
 * HOSTILE-INPUT BOUNDARY: STRING-ONLY/JSON-detached, bounded, no functions/
 * symbols/accessors/class instances/cycles/prototype pollution. Authority-
 * shaped keys are rejected recursively. No hidden authority inside arbitrary
 * metadata.
 */

const crypto = require("node:crypto");
const { fail, REASONS: ACT_REASONS, requestBrandSet } = require("./errors");
const { isValidIncarnationId } = require("../intent");
const { canonicalScope } = require("../intent");

const REQUEST_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_EXECUTION_ID_CHARS: 128,
    MAX_INTENT_ID_CHARS: 128,
    MAX_CAPABILITY_ID_CHARS: 256,
    MAX_OPERATION_CHARS: 256,
    MAX_PRINCIPAL_CHARS: 128,
    MAX_PARAMETERS_BYTES: 64 * 1024,
    MAX_PARAMETERS_KEYS: 64,
    MAX_METADATA_NODES: 512,
    MAX_METADATA_DEPTH: 8,
    MAX_METADATA_KEY_CHARS: 128,
    MAX_METADATA_STRING_CHARS: 256,
    GLOBAL_MAX_ARRAY_LENGTH: 1024
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

const AUTHORITY_SHAPED_TOKENS = Object.freeze(new Set([
    "authority", "authorized", "authorization", "authorisation",
    "permission", "permissions", "approved", "approval", "approve",
    "ownerapproved", "owner", "admin", "administrator", "root", "superuser",
    "grant", "granted", "trusted", "trust", "privilege", "privileged",
    "role", "roles", "canexecute", "allowed", "allow"
]));

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function detach(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail(ACT_REASONS.BOUND_EXCEEDED, `payload exceeds node budget (${state.maxNodes})`);
    }
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value;
    if (t === "number") {
        if (!Number.isFinite(value)) throw fail(ACT_REASONS.MALFORMED_PAYLOAD, "numbers must be finite");
        return value;
    }
    if (t === "function") throw fail(ACT_REASONS.FUNCTION_VALUE, "function values are not permitted");
    if (t === "symbol" || t === "bigint" || t === "undefined") {
        throw fail(ACT_REASONS.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail(ACT_REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > BOUNDS.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail(ACT_REASONS.BOUND_EXCEEDED, `array length exceeds global bound`);
        }
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = detach(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!isPlainObject(value)) {
        throw fail(ACT_REASONS.NON_PLAIN_OBJECT, "non-plain object is not permitted");
    }
    if (state.path.has(value)) throw fail(ACT_REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (DANGEROUS_KEYS.has(key)) throw fail(ACT_REASONS.DANGEROUS_KEY, `dangerous key '${key}' in payload`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail(ACT_REASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = detach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail(ACT_REASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

function assertNoAuthorityKeys(node) {
    if (node === null || typeof node !== "object") return;
    for (const key of Object.getOwnPropertyNames(node)) {
        if (AUTHORITY_SHAPED_TOKENS.has(key.toLowerCase())) {
            throw fail(ACT_REASONS.MALFORMED_REQUEST, `authority-shaped key '${key}' is forbidden in execution request metadata`);
        }
        const v = node[key];
        if (v !== null && typeof v === "object") assertNoAuthorityKeys(v);
    }
}

function requireString(value, field, maxChars, { optional = false, allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        if (optional) return "";
        throw fail(ACT_REASONS.MALFORMED_REQUEST, `${field} is required`);
    }
    if (typeof value !== "string") {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, `${field} must be a string, got ${typeof value}`);
    }
    const s = value.trim();
    if (!optional && !allowEmpty && s.length === 0) {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, `${field} must not be empty`);
    }
    if (s.length > maxChars) {
        throw fail(ACT_REASONS.BOUND_EXCEEDED, `${field} exceeds ${maxChars} chars`);
    }
    return s;
}

function requireSafeInteger(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, `${field} must be a nonnegative safe integer`);
    }
    return value;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/**
 * PRIVILEGED (dispatcher-private) — form an immutable canonical ExecutionRequest.
 *
 * @param {object} ctx
 * @param {string} ctx.intentId            canonical ActionIntent intentId
 * @param {string} ctx.capabilityId       canonical capability id
 * @param {string} ctx.capabilityIncarnationId  canonical capability incarnation
 * @param {string} ctx.operation          declared operation
 * @param {string} ctx.principal          authenticated principal
 * @param {string[]} ctx.scope            canonical scope tokens
 * @param {number}  ctx.authorityGeneration  Authority generation observed at formation
 * @param {number}  ctx.admittedAtMs      intent admission timestamp
 * @param {number}  ctx.requestedAtMs    request formation timestamp
 * @param {object}  [ctx.parameters]     payload snapshot (detached, bounded)
 * @param {object}  [ctx.metadata]      metadata (detached, bounded, no authority keys)
 * @returns {object} frozen ExecutionRequest
 */
function formExecutionRequest(ctx) {
    if (ctx === null || typeof ctx !== "object") {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, "execution request context must be a plain object");
    }

    const intentId = requireString(ctx.intentId, "intentId", BOUNDS.MAX_INTENT_ID_CHARS);
    const capabilityId = requireString(ctx.capabilityId, "capabilityId", BOUNDS.MAX_CAPABILITY_ID_CHARS);
    const capabilityIncarnationId = requireString(ctx.capabilityIncarnationId, "capabilityIncarnationId", BOUNDS.MAX_INTENT_ID_CHARS);
    if (!isValidIncarnationId(capabilityIncarnationId)) {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, "capabilityIncarnationId is not a valid canonical incarnation id");
    }
    const operation = requireString(ctx.operation, "operation", BOUNDS.MAX_OPERATION_CHARS);
    const principal = requireString(ctx.principal, "principal", BOUNDS.MAX_PRINCIPAL_CHARS);
    if (!Array.isArray(ctx.scope)) {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, "scope must be an array of canonical tokens");
    }
    const scope = canonicalScope(ctx.scope);
    const authorityGeneration = requireSafeInteger(ctx.authorityGeneration, "authorityGeneration");
    const admittedAtMs = requireSafeInteger(ctx.admittedAtMs, "admittedAtMs");
    const requestedAtMs = requireSafeInteger(ctx.requestedAtMs, "requestedAtMs");
    if (requestedAtMs < admittedAtMs) {
        throw fail(ACT_REASONS.MALFORMED_REQUEST, "requestedAtMs must be >= admittedAtMs");
    }

    // Detached, bounded, hostile-input-safe payload snapshot.
    const parametersState = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const parameters = (ctx.parameters === undefined || ctx.parameters === null)
        ? deepFreeze({})
        : deepFreeze(detach(ctx.parameters, parametersState));
    if (Object.getOwnPropertyNames(parameters).length > BOUNDS.MAX_PARAMETERS_KEYS) {
        throw fail(ACT_REASONS.BOUND_EXCEEDED, `parameters exceeds ${BOUNDS.MAX_PARAMETERS_KEYS} keys`);
    }

    const metadataState = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const metadata = (ctx.metadata === undefined || ctx.metadata === null)
        ? deepFreeze({})
        : deepFreeze(detach(ctx.metadata, metadataState));
    assertNoAuthorityKeys(metadata);

    const executionId = crypto.randomUUID();

    const request = deepFreeze({
        schemaVersion: REQUEST_SCHEMA_VERSION,
        executionId,
        intentId,
        capabilityId,
        capabilityIncarnationId,
        operation,
        principal,
        scope,
        authorityGeneration,
        admittedAtMs,
        requestedAtMs,
        parameters,
        metadata
    });
    // Brand as canonical (closure-only WeakSet in errors.js; read by the
    // public PURE predicate isCanonicalExecutionRequest). Clone/JSON/forged
    // shapes are never in the brand.
    requestBrandSet.add(request);
    return request;
}

module.exports = { formExecutionRequest, BOUNDS, REQUEST_SCHEMA_VERSION };
