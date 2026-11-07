"use strict";

/**
 * CAPABILITY REGISTRY V1 — CapabilityDescriptor (canonical immutable data).
 *
 * A descriptor is a closed, schema-versioned, deep-frozen canonical value.
 * It is DESCRIPTIVE ONLY: it describes what a capability IS, where it came
 * from, what it depends on, and how available it currently appears. It never
 * grants, ratifies, approves, delegates, or authorizes anything.
 *
 * Hostile input defenses (fail closed):
 *   - non-plain objects rejected
 *   - accessor properties (getters/setters) rejected
 *   - function values rejected
 *   - symbol keys/values rejected
 *   - cyclic structures rejected
 *   - Proxy second-read smuggling rejected (each own property is read exactly
 *     once into a detached canonical value; the original object is never
 *     retained or re-read)
 *   - dangerous keys (__proto__/constructor/prototype) rejected at depth
 *   - unknown fields rejected (closed schema); authority-shaped fields are
 *     unknown here and rejected with a clear reason
 *   - unbounded strings/arrays/maps rejected against explicit bounds
 *   - nested metadata traversed under a GLOBAL node budget (no per-branch
 *     reset), preventing OOM-shaped DAG amplification
 */

const { fail, REASONS } = require("./errors");
const { canonicalCapabilityId, AUTHORITY_VOCABULARY } = require("./ids");
const { canonicalKind } = require("./kinds");
const { canonicalAvailability } = require("./availability");

const DESCRIPTOR_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_DESCRIPTOR_BYTES: 64 * 1024,
    MAX_ID_CHARS: 256,
    MAX_PROVENANCE_CHARS: 256,
    MAX_PROVIDER_CHARS: 128,
    MAX_OPERATIONS: 64,
    MAX_OPERATION_CHARS: 256,
    MAX_REQUIREMENTS: 64,
    MAX_REQUIREMENT_CHARS: 256,
    MAX_DEPENDENCIES: 64,
    MAX_EFFECTS: 64,
    MAX_EFFECT_CHARS: 256,
    MAX_DESCRIPTION_CHARS: 512,
    MAX_METADATA_DEPTH: 8,
    MAX_METADATA_NODES: 512,
    MAX_METADATA_KEY_CHARS: 128,
    MAX_METADATA_STRING_CHARS: 256,
    GLOBAL_MAX_ARRAY_LENGTH: 4096
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

const AUTHORITY_SHAPED_FIELDS = Object.freeze(new Set([
    "authorized", "approved", "owner", "root", "trusted", "granted",
    "ratified", "delegated", "elevated", "permitted", "authority",
    "isAuthority", "canAuthorize"
]));

/**
 * Descriptor is descriptive capability data ONLY. It must NOT carry an
 * authoritative `provenance` field — provenance identity originates from the
 * registrar/registration envelope, not the descriptor. A descriptor that
 * supplies `provenance` is rejected (never silently ignored or overridden).
 */
const KNOWN_FIELDS = Object.freeze([
    "schemaVersion", "id", "kind", "provider", "source", "operations",
    "requirements", "effects", "availability", "dependencies",
    "metadata", "description"
]);

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function requireString(value, field, maxChars, opts = {}) {
    const { optional = false, allowEmpty = false } = opts;
    if (value === undefined) {
        if (optional) return undefined;
        throw fail(REASONS.MALFORMED_INPUT, `descriptor field '${field}' is required`);
    }
    if (typeof value !== "string") {
        throw fail(REASONS.MALFORMED_INPUT, `descriptor field '${field}' must be string, got ${typeof value}`);
    }
    if (!allowEmpty && !value.trim()) {
        throw fail(REASONS.MALFORMED_INPUT, `descriptor field '${field}' must be non-empty`);
    }
    if (value.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `descriptor field '${field}' exceeds ${maxChars} chars`, { length: value.length });
    }
    return value;
}

function boundedStringList(value, field, maxItems, maxChars) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw fail(REASONS.MALFORMED_INPUT, `descriptor field '${field}' must be an array`);
    }
    if (value.length > maxItems) {
        throw fail(REASONS.BOUND_EXCEEDED, `descriptor field '${field}' exceeds ${maxItems} items`, { count: value.length });
    }
    const out = [];
    for (const item of value) {
        if (typeof item !== "string") {
            throw fail(REASONS.MALFORMED_INPUT, `descriptor field '${field}' must contain only strings`);
        }
        if (item.length > maxChars) {
            throw fail(REASONS.BOUND_EXCEEDED, `descriptor field '${field}' item exceeds ${maxChars} chars`);
        }
        out.push(item);
    }
    return [...new Set(out)].sort();
}

function parseDependencies(raw) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw fail(REASONS.MALFORMED_INPUT, "dependencies must be an array of ids");
    }
    if (raw.length > BOUNDS.MAX_DEPENDENCIES) {
        throw fail(REASONS.BOUND_EXCEEDED, `dependencies exceeds ${BOUNDS.MAX_DEPENDENCIES} items`, { count: raw.length });
    }
    const out = new Set();
    for (const item of raw) out.add(canonicalCapabilityId(item));
    return [...out].sort();
}

/**
 * Single-pass structural detach. Reads each own property exactly once (via
 * Object.getOwnPropertyDescriptor(...).value, which NEVER invokes a getter)
 * into a canonical plain-data clone. Rejects non-plain objects, accessors,
 * functions, symbols, dangerous keys, and cycles (via a path set). Bounded by
 * a global node budget shared across the whole walk.
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
        if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted in descriptors");
        // Bound-check BEFORE any allocation/copy based on attacker-controlled
        // length (a sparse array can report a huge length cheaply).
        if (value.length > BOUNDS.GLOBAL_MAX_ARRAY_LENGTH) {
            throw fail(REASONS.BOUND_EXCEEDED,
                `array length ${value.length} exceeds global bound ${BOUNDS.GLOBAL_MAX_ARRAY_LENGTH}`,
                { length: value.length, maxLength: BOUNDS.GLOBAL_MAX_ARRAY_LENGTH });
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
    if (state.path.has(value)) throw fail(REASONS.CYCLIC_INPUT, "cyclic structure is not permitted in descriptors");
    state.path.add(value);
    const out = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        if (DANGEROUS_KEYS.has(key)) throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' in input`);
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (desc && (desc.get || desc.set)) {
            throw fail(REASONS.ACCESSOR_PROPERTY, `accessor property '${key}' is not permitted`);
        }
        // single read: desc.value never invokes a getter
        out[key] = detach(desc.value, state);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw fail(REASONS.SYMBOL_VALUE, "symbol keys are not permitted");
    }
    state.path.delete(value);
    return out;
}

/** Enforce metadata-specific bounds (depth, key/string length) and reject
 *  authority/policy-shaped keys (case-insensitive, at any nesting level) on
 *  the already-detached (safe, acyclic, plain) metadata tree. */
function enforceMetadataBounds(node) {
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES };
    walkMetadata(node, 0, state);
}

/** Recursively reject authority/policy-shaped keys case-insensitively. */
function assertNoAuthorityKeys(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const item of node) assertNoAuthorityKeys(item);
        return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
        const folded = key.toLowerCase();
        if (AUTHORITY_VOCABULARY.has(folded)) {
            throw fail(REASONS.AUTHORITY_METADATA,
                `metadata key '${key}' is authority-shaped and is rejected`,
                { key });
        }
        assertNoAuthorityKeys(node[key]);
    }
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

function parseMetadata(raw) {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) throw fail(REASONS.MALFORMED_INPUT, "metadata must be a plain object");
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(raw, state);
    enforceMetadataBounds(detached);
    assertNoAuthorityKeys(detached);
    return detached;
}

/**
 * Parse and detach observation metadata (an inert, bounded, authority-free
 * metadata bag carried alongside an availability observation). Returns a
 * deep-frozen plain object; rejects functions, accessors, symbols, non-plain
 * objects, cycles, bounds, and authority-shaped keys.
 */
function parseObservationMetadata(raw) {
    if (raw === undefined || raw === null) return Object.freeze({});
    if (!isPlainObject(raw)) {
        throw fail(REASONS.MALFORMED_INPUT, "observation metadata must be a plain object");
    }
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(raw, state);
    enforceMetadataBounds(detached);
    assertNoAuthorityKeys(detached);
    return deepFreeze(detached);
}

function parseCapabilityDescriptor(input, { source = "inline", nowMs = null } = {}) {
    let body = input;
    // Serialized boundary is STRING-ONLY (no instanceof / no typed-array brand
    // check that could trigger a Proxy getPrototypeOf trap). Bytes are not
    // accepted at the untrusted boundary.
    if (typeof input === "string") {
        if (Buffer.byteLength(input, "utf8") > BOUNDS.MAX_DESCRIPTOR_BYTES) {
            throw fail(REASONS.BOUND_EXCEEDED, `descriptor exceeds ${BOUNDS.MAX_DESCRIPTOR_BYTES} bytes`, { bytes: Buffer.byteLength(input, "utf8") });
        }
        try {
            body = JSON.parse(input);
        } catch {
            throw fail(REASONS.MALFORMED_JSON, "descriptor is not valid JSON", { source });
        }
    }
    if (!isPlainObject(body)) {
        throw fail(REASONS.NON_PLAIN_OBJECT, `descriptor must be a plain JSON object, got ${Array.isArray(body) ? "array" : typeof body}`);
    }

    // Single-pass structural detach of the whole input: plainness, accessors,
    // functions, symbols, dangerous keys, cycles, and a global node budget.
    // The hostile original is read exactly once per own property and never
    // retained.
    const state = { nodes: 0, maxNodes: BOUNDS.MAX_METADATA_NODES, path: new Set() };
    const detached = detach(body, state);

    if (detached.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
        throw fail(REASONS.UNSUPPORTED_SCHEMA,
            `unsupported descriptor schemaVersion: ${JSON.stringify(detached.schemaVersion) ?? "undefined"}`,
            { expected: DESCRIPTOR_SCHEMA_VERSION });
    }

    for (const key of Object.getOwnPropertyNames(detached)) {
        if (!KNOWN_FIELDS.includes(key)) {
            if (AUTHORITY_SHAPED_FIELDS.has(key) || AUTHORITY_VOCABULARY.has(key.toLowerCase())) {
                throw fail(REASONS.UNKNOWN_FIELD, `descriptor field '${key}' is an authority-shaped field and is rejected`);
            }
            // `provenance` is explicitly not a descriptor field: provenance
            // identity originates from the registrar, never the descriptor.
            if (key === "provenance") {
                throw fail(REASONS.FORBIDDEN_PROVENANCE,
                    `descriptor must not define authoritative provenance; register via a registrar`);
            }
            throw fail(REASONS.UNKNOWN_FIELD, `unknown descriptor field '${key}'`);
        }
    }

    if (typeof detached.id !== "string") {
        throw fail(REASONS.INVALID_CAPABILITY_ID, `capability id must be string, got ${typeof detached.id}`);
    }
    const id = canonicalCapabilityId(detached.id);
    const kind = canonicalKind(requireString(detached.kind, "kind", 32));
    const provider = requireString(detached.provider, "provider", BOUNDS.MAX_PROVIDER_CHARS, { allowEmpty: true }) ?? "";
    const description = requireString(detached.description, "description", BOUNDS.MAX_DESCRIPTION_CHARS, { optional: true, allowEmpty: true }) ?? "";

    const operations = boundedStringList(detached.operations, "operations", BOUNDS.MAX_OPERATIONS, BOUNDS.MAX_OPERATION_CHARS);
    const requirements = boundedStringList(detached.requirements, "requirements", BOUNDS.MAX_REQUIREMENTS, BOUNDS.MAX_REQUIREMENT_CHARS);
    const effects = boundedStringList(detached.effects, "effects", BOUNDS.MAX_EFFECTS, BOUNDS.MAX_EFFECT_CHARS);
    const dependencies = parseDependencies(detached.dependencies);
    const metadata = parseMetadata(detached.metadata);

    let availability = "UNKNOWN";
    if (detached.availability !== undefined) {
        availability = canonicalAvailability(requireString(detached.availability, "availability", 32));
    }

    const sourceValue = detached.source === undefined
        ? source
        : (requireString(detached.source, "source", BOUNDS.MAX_PROVENANCE_CHARS, { allowEmpty: true }) ?? source);

    return deepFreeze({
        schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
        id,
        kind,
        provider,
        source: sourceValue,
        operations: Object.freeze(operations),
        requirements: Object.freeze(requirements),
        effects: Object.freeze(effects),
        availability,
        dependencies: Object.freeze(dependencies),
        metadata: deepFreeze(metadata),
        description,
        registeredAtMs: nowMs
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
    parseCapabilityDescriptor,
    parseObservationMetadata,
    DESCRIPTOR_SCHEMA_VERSION,
    BOUNDS,
    AUTHORITY_SHAPED_FIELDS,
    KNOWN_FIELDS,
    isPlainObject
};
