"use strict";

/**
 * ACTION INTENT V1 — ActionIntent (immutable canonical proposal).
 *
 * An ActionIntent is an immutable, descriptive proposal to perform ONE
 * capability operation. It is DESCRIPTIVE, not NORMATIVE:
 *
 *   "actor X proposes operation Y on capability Z with arguments A"
 *
 * It NEVER means "actor X is allowed to do Y".
 *
 * LAWS ENFORCED HERE:
 *   INTENT != AUTHORITY
 *   PLAN  != AUTHORITY
 *   MODEL CLAIM != AUTHORITY
 *   MEMORY != AUTHORITY
 *   CHANNEL != AUTHORITY
 *
 * Authority-shaped state is rejected atomically (typed, fail-closed) at ANY
 * depth of the intent and its metadata — case-insensitively. Rejected tokens
 * include: authority/authorized/authorization/permission/permissions/
 * approved/approval/ownerApproved/owner/admin/root/grant/granted/trusted/
 * trust/privilege/privileged/role/roles/canExecute/allowed/allow.
 *
 * HOSTILE-INPUT BOUNDARY: untrusted ingestion is STRING-ONLY JSON. Arbitrary
 * JS objects are rejected via a primitive typeof check (no reflective
 * inspection) so a Proxy cannot execute traps during rejection. The parsed
 * body is detached into inert plain data via a single-pass read of each own
 * property (Object.getOwnPropertyDescriptor(...).value never invokes getters).
 *
 * IDENTITY: intentId is runtime-minted (crypto.randomUUID), never caller
 * chosen. A caller correlation id is kept separate (correlationId).
 */

const crypto = require("node:crypto");

const { fail, REASONS } = require("./errors");
const { canonicalCapabilityId } = require("../capability/registry/ids");

const INTENT_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_INTENT_BYTES: 64 * 1024,
    MAX_CAPABILITY_ID_CHARS: 256,
    MAX_OPERATION_CHARS: 256,
    MAX_SUBJECT_CHARS: 128,
    MAX_SESSION_CHARS: 128,
    MAX_CHANNEL_CHARS: 64,
    MAX_CORRELATION_CHARS: 256,
    MAX_INCARNATION_CHARS: 64,
    MAX_METADATA_DEPTH: 8,
    MAX_METADATA_NODES: 512,
    MAX_METADATA_KEY_CHARS: 128,
    MAX_METADATA_STRING_CHARS: 256,
    MAX_ARGUMENTS_KEYS: 64,
    GLOBAL_MAX_ARRAY_LENGTH: 1024
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

/**
 * Authority/policy-shaped vocabulary for ACTION INTENT. Exact, case-folded
 * token match (the mission's explicit list, verbatim, plus camelCase variants
 * folded to lowercase). A key is rejected when its lowercase form exactly
 * equals one of these tokens.
 */
const INTENT_AUTHORITY_TOKENS = Object.freeze(new Set([
    "authority", "authorized", "authorization", "authorisation",
    "permission", "permissions", "approved", "approval", "approve",
    "ownerapproved", "owner", "admin", "administrator", "root", "superuser",
    "grant", "granted", "trusted", "trust", "privilege", "privileged",
    "role", "roles", "canexecute", "allowed", "allow"
]));

/** Top-level canonical intent fields. Anything else is unknown => reject. */
const KNOWN_FIELDS = Object.freeze([
    "schemaVersion", "capabilityId", "capabilityIncarnationId", "operation",
    "arguments", "subject", "session", "channel", "correlationId",
    "createdAtMs", "metadata"
]);

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function truncate(s) {
    return typeof s === "string" ? s.slice(0, 80) : String(s).slice(0, 80);
}

/**
 * Single-pass structural detach. Reads each own property exactly once (via
 * Object.getOwnPropertyDescriptor(...).value, never invoking a getter) into a
 * canonical plain-data clone. Rejects non-plain objects, accessors, functions,
 * symbols, dangerous keys, cycles, and oversized arrays (bound-checked BEFORE
 * allocation). Bounded by a global node budget.
 */
function detach(value, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail(REASONS.BOUND_EXCEEDED, `input exceeds global node budget (${state.maxNodes})`, { maxNodes: state.maxNodes });
    }
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value;
    if (t === "number") {
        if (!Number.isFinite(value)) throw fail(REASONS.MALFORMED_INPUT, "numbers must be finite");
        return value;
    }
    if (t === "function") throw fail(REASONS.FUNCTION_VALUE, "function values are not permitted");
    if (t === "symbol" || t === "bigint" || t === "undefined") {
        throw fail(REASONS.SYMBOL_VALUE, `${t} values are not permitted`);
    }
    if (Array.isArray(value)) {
        if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
        if (value.length > BOUNDS.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail(REASONS.BOUND_EXCEEDED, `array length ${value.length} exceeds global bound ${BOUNDS.GLOBAL_MAX_ARRAY_LENGTH}`, { length: value.length, maxLength: BOUNDS.GLOBAL_MAX_ARRAY_LENGTH });
        }
        state.path.add(value);
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = detach(value[i], state);
        state.path.delete(value);
        return out;
    }
    if (!isPlainObject(value)) {
        throw fail(REASONS.NON_PLAIN_OBJECT, `non-plain object (${Object.prototype.toString.call(value)}) is not permitted`);
    }
    if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (DANGEROUS_KEYS.has(key)) throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' in input`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail(REASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        out[key] = detach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail(REASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

/**
 * Recursively reject authority/policy-shaped keys CASE-INSENSITIVELY at any
 * nesting level (exact token match after lowercasing). Runs over the
 * already-detached (safe) plain data.
 */
function assertNoAuthorityKeys(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const item of node) assertNoAuthorityKeys(item);
        return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
        if (isAuthorityShapedKey(key)) {
            throw fail(REASONS.AUTHORITY_METADATA, `field '${key}' is authority-shaped and is rejected`, { key });
        }
        assertNoAuthorityKeys(node[key]);
    }
}

function isAuthorityShapedKey(key) {
    return INTENT_AUTHORITY_TOKENS.has(String(key).toLowerCase());
}

function requireString(value, field, maxChars, opts = {}) {
    const { optional = false, allowEmpty = false } = opts;
    if (value === undefined) {
        if (optional) return undefined;
        throw fail(REASONS.INVALID_INTENT, `intent field '${field}' is required`);
    }
    if (typeof value !== "string") {
        throw fail(REASONS.INVALID_INTENT, `intent field '${field}' must be string, got ${typeof value}`);
    }
    if (!allowEmpty && !value.trim()) {
        throw fail(REASONS.INVALID_INTENT, `intent field '${field}' must be non-empty`);
    }
    if (value.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `intent field '${field}' exceeds ${maxChars} chars`, { length: value.length });
    }
    return value;
}

function parseArguments(raw) {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) throw fail(REASONS.INVALID_INTENT, "arguments must be a plain object");
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(raw, state);
    if (Object.getOwnPropertyNames(detached).length > BOUNDS.MAX_ARGUMENTS_KEYS) {
        throw fail(REASONS.BOUND_EXCEEDED, `arguments exceeds ${BOUNDS.MAX_ARGUMENTS_KEYS} keys`);
    }
    assertNoAuthorityKeys(detached);
    return detached;
}

function parseMetadata(raw) {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) throw fail(REASONS.INVALID_INTENT, "metadata must be a plain object");
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(raw, state);
    enforceMetadataBounds(detached);
    assertNoAuthorityKeys(detached);
    return detached;
}

function enforceMetadataBounds(node) {
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES };
    walkMetadata(node, 0, state);
}

function walkMetadata(node, depth, state) {
    state.nodes++;
    if (state.nodes > state.maxNodes) {
        throw fail(REASONS.BOUND_EXCEEDED, `metadata exceeds global node budget (${state.maxNodes})`, { maxNodes: state.maxNodes });
    }
    if (depth > BOUNDS.MAX_METADATA_DEPTH) {
        throw fail(REASONS.BOUND_EXCEEDED, `metadata exceeds maximum depth ${BOUNDS.MAX_METADATA_DEPTH}`, { depth, maxDepth: BOUNDS.MAX_METADATA_DEPTH });
    }
    if (node === null || typeof node !== "object") {
        if (typeof node === "string" && node.length > BOUNDS.MAX_METADATA_STRING_CHARS) {
            throw fail(REASONS.UNBOUNDED_STRING, `metadata string exceeds ${BOUNDS.MAX_METADATA_STRING_CHARS} chars`);
        }
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) walkMetadata(item, depth + 1, state);
        return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
        if (key.length > BOUNDS.MAX_METADATA_KEY_CHARS) {
            throw fail(REASONS.BOUND_EXCEEDED, `metadata key exceeds ${BOUNDS.MAX_METADATA_KEY_CHARS} chars`);
        }
        walkMetadata(node[key], depth + 1, state);
    }
}

function isValidIncarnationId(value) {
    return typeof value === "string" && /^inc-[0-9a-f]{32}$/.test(value);
}

/**
 * Parse + validate an untrusted ActionIntent. STRING-ONLY JSON at the
 * untrusted boundary. Returns a detached, deeply-frozen canonical intent.
 * Throws ActionError on any rejection. Never executes code, never retains
 * live objects, never mints authority.
 */
function parseActionIntent(input, { source = "inline", nowMs = null } = {}) {
    let body = input;
    if (typeof input === "string") {
        if (Buffer.byteLength(input, "utf8") > BOUNDS.MAX_INTENT_BYTES) {
            throw fail(REASONS.BOUND_EXCEEDED, `intent exceeds ${BOUNDS.MAX_INTENT_BYTES} bytes`, { bytes: Buffer.byteLength(input, "utf8") });
        }
        try {
            body = JSON.parse(input);
        } catch {
            throw fail(REASONS.MALFORMED_JSON, "intent is not valid JSON", { source });
        }
    } else if (input === undefined || input === null) {
        throw fail(REASONS.OBJECT_INPUT_NOT_ALLOWED, "untrusted intent requires a serialized JSON string");
    } else {
        // STRING-ONLY boundary: reject every non-string via primitive typeof
        // with NO reflective inspection (no instanceof, no property access).
        throw fail(REASONS.OBJECT_INPUT_NOT_ALLOWED, "untrusted intent requires a serialized JSON string; object input is not accepted");
    }

    if (!isPlainObject(body)) {
        throw fail(REASONS.NON_PLAIN_OBJECT, `intent must be a plain JSON object, got ${Array.isArray(body) ? "array" : typeof body}`);
    }

    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(body, state);

    if (detached.schemaVersion !== INTENT_SCHEMA_VERSION) {
        throw fail(REASONS.UNSUPPORTED_SCHEMA, `unsupported intent schemaVersion: ${JSON.stringify(detached.schemaVersion) ?? "undefined"}`, { expected: INTENT_SCHEMA_VERSION });
    }

    // closed schema + authority-shaped top-level fields rejected
    for (const key of Object.getOwnPropertyNames(detached)) {
        if (!KNOWN_FIELDS.includes(key)) {
            if (isAuthorityShapedKey(key)) {
                throw fail(REASONS.AUTHORITY_METADATA, `intent field '${key}' is authority-shaped and is rejected`, { key });
            }
            throw fail(REASONS.UNKNOWN_FIELD, `unknown intent field '${key}'`);
        }
    }

    if (typeof detached.capabilityId !== "string") {
        throw fail(REASONS.INVALID_CAPABILITY_ID, `capabilityId must be string, got ${typeof detached.capabilityId}`);
    }
    const capabilityId = canonicalCapabilityId(detached.capabilityId);

    const operation = requireString(detached.operation, "operation", BOUNDS.MAX_OPERATION_CHARS);
    const subject = requireString(detached.subject, "subject", BOUNDS.MAX_SUBJECT_CHARS);
    const session = requireString(detached.session, "session", BOUNDS.MAX_SESSION_CHARS, { optional: true, allowEmpty: true }) ?? "";
    const channel = requireString(detached.channel, "channel", BOUNDS.MAX_CHANNEL_CHARS, { optional: true, allowEmpty: true }) ?? "";
    const correlationId = requireString(detached.correlationId, "correlationId", BOUNDS.MAX_CORRELATION_CHARS, { optional: true, allowEmpty: true }) ?? "";

    // capabilityIncarnationId: optional; validated for shape when present.
    let capabilityIncarnationId = null;
    if (detached.capabilityIncarnationId !== undefined && detached.capabilityIncarnationId !== null) {
        if (typeof detached.capabilityIncarnationId !== "string") {
            throw fail(REASONS.INVALID_INTENT, "capabilityIncarnationId must be a string");
        }
        if (detached.capabilityIncarnationId.length > BOUNDS.MAX_INCARNATION_CHARS) {
            throw fail(REASONS.BOUND_EXCEEDED, "capabilityIncarnationId exceeds bound");
        }
        capabilityIncarnationId = detached.capabilityIncarnationId;
    }

    // createdAtMs: validated timestamp; malformed => typed reject.
    let createdAtMs;
    if (detached.createdAtMs !== undefined) {
        if (typeof detached.createdAtMs !== "number" || !Number.isFinite(detached.createdAtMs) || !Number.isSafeInteger(detached.createdAtMs) || detached.createdAtMs < 0) {
            throw fail(REASONS.MALFORMED_INPUT, `createdAtMs must be a nonnegative safe integer, got ${typeof detached.createdAtMs}`);
        }
        createdAtMs = detached.createdAtMs;
    } else {
        createdAtMs = nowMs;
    }

    const args = parseArguments(detached.arguments);
    const metadata = parseMetadata(detached.metadata);

    // intentId is RUNTIME-MINTED, never caller chosen.
    const intentId = crypto.randomUUID();

    return deepFreeze({
        schemaVersion: INTENT_SCHEMA_VERSION,
        intentId,
        capabilityId,
        capabilityIncarnationId,
        operation,
        arguments: deepFreeze(args),
        subject,
        session,
        channel,
        correlationId,
        source: String(source ?? "inline").slice(0, 128),
        createdAtMs,
        metadata: deepFreeze(metadata)
    });
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = {
    parseActionIntent,
    INTENT_SCHEMA_VERSION,
    BOUNDS,
    KNOWN_FIELDS,
    isPlainObject,
    isValidIncarnationId,
    INTENT_AUTHORITY_TOKENS
};
