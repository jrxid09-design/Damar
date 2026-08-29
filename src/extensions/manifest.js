"use strict";

/**
 * EXTENSION KERNEL V1 — ExtensionManifest (untrusted declarative input).
 *
 * LAWS ENFORCED HERE:
 *   - A manifest claiming `authority` grants nothing.
 *   - A manifest advertising a capability creates no permission.
 *   - A manifest claiming `trusted: true` establishes no trust.
 *
 * The manifest is a closed schema: unknown top-level fields are rejected
 * (fail-closed, schema versioned). All dangerous keys are rejected at any
 * depth. Output is a frozen descriptor; callers can never mutate kernel or
 * registry state through the parsed result.
 */

const { fail, REASONS } = require("./errors");
const { createExtensionId, canonicalCapabilityName, createProjectId } = require("./ids");
const { parseVersion, satisfiesRange } = require("./semver");

const MANIFEST_SCHEMA_VERSION = 1;

const BOUNDS = Object.freeze({
    MAX_MANIFEST_BYTES: 64 * 1024,
    MAX_CAPABILITIES: 32,
    MAX_DEPENDENCIES: 16,
    MAX_AUTHORITY_REQUIREMENTS: 32,
    MAX_PROJECTS: 64,
    MAX_DESCRIPTION_CHARS: 512,
    MAX_NAME_CHARS: 128,
    MAX_CONFIG_BYTES: 8 * 1024,
    MAX_ENTRY_PATH_CHARS: 256
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));
const CATEGORIES = Object.freeze(new Set([
    "general", "integration", "device", "provider", "tooling", "observability"
]));
const RESOURCE_CLASSES = Object.freeze(new Set(["LIGHT", "MEDIUM", "HEAVY"]));
const DURATION_CLASSES = Object.freeze(new Set(["SHORT", "MEDIUM", "LONG"]));

function isPlainObject(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** Reject dangerous keys at any depth of arrays/plain objects. */
function assertNoDangerousKeys(node, path) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            assertNoDangerousKeys(node[i], `${path}[${i}]`);
        }
        return;
    }
    if (!isPlainObject(node)) return;
    for (const key of Object.getOwnPropertyNames(node)) {
        if (DANGEROUS_KEYS.has(key)) {
            throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' at ${path || "<root>"}`,
                { key, path });
        }
        assertNoDangerousKeys(node[key], path ? `${path}.${key}` : key);
    }
}

function requireString(value, field, maxChars, { optional = false } = {}) {
    if (value === undefined) {
        if (optional) return undefined;
        throw fail(REASONS.MALFORMED_INPUT, `manifest field '${field}' is required`);
    }
    if (typeof value !== "string") {
        throw fail(REASONS.MALFORMED_INPUT, `manifest field '${field}' must be string, got ${typeof value}`);
    }
    const trimmed = value.trim();
    if (!optional && !trimmed) {
        throw fail(REASONS.MALFORMED_INPUT, `manifest field '${field}' must be non-empty`);
    }
    if (trimmed.length > maxChars) {
        throw fail(REASONS.BOUND_EXCEEDED, `manifest field '${field}' exceeds ${maxChars} chars`,
            { length: trimmed.length });
    }
    return trimmed;
}

function boundedList(value, field, maxItems) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw fail(REASONS.MALFORMED_INPUT, `manifest field '${field}' must be an array`);
    }
    if (value.length > maxItems) {
        throw fail(REASONS.BOUND_EXCEEDED, `manifest field '${field}' exceeds ${maxItems} items`,
            { count: value.length });
    }
    return value;
}

function parseDependencies(raw) {
    const list = boundedList(raw, "dependencies", BOUNDS.MAX_DEPENDENCIES);
    const seen = new Map();
    for (const item of list) {
        if (!isPlainObject(item)) {
            throw fail(REASONS.MALFORMED_INPUT, "each dependency must be an object");
        }
        for (const key of Object.getOwnPropertyNames(item)) {
            if (!["id", "optional", "versionRange"].includes(key)) {
                throw fail(REASONS.UNKNOWN_FIELD, `unknown dependency field '${key}'`);
            }
        }
        const id = createExtensionId(item.id).value;
        const optional = item.optional === undefined ? false : item.optional;
        if (typeof optional !== "boolean") {
            throw fail(REASONS.MALFORMED_INPUT, "dependency 'optional' must be boolean");
        }
        let range = null;
        if (item.versionRange !== undefined) {
            // validate now; stored verbatim
            probeRange(item.versionRange);
            range = item.versionRange.trim();
        }
        if (seen.has(id)) {
            throw fail(REASONS.DUPLICATE_EXTENSION,
                `duplicate dependency '${id}' with conflicting declaration`);
        }
        seen.set(id, deepFreeze({ id, optional, versionRange: range }));
    }
    // deterministic order: required first, then by id
    return deepFreeze([...seen.values()].sort((a, b) =>
        (a.optional === b.optional) ? (a.id < b.id ? -1 : 1) : (a.optional ? 1 : -1)));
}

function probeRange(rangeRaw) {
    // "*" and exact versions validate via satisfiesRange against itself
    satisfiesRange(parseVersion("0.0.1"), typeof rangeRaw === "string" && rangeRaw.trim() === "" ? "*" : rangeRaw);
}

function parseResourceExpectations(raw) {
    if (raw === undefined) return deepFreeze({});
    if (!isPlainObject(raw)) throw fail(REASONS.MALFORMED_INPUT, "'resources' must be an object");
    const out = {};
    for (const key of Object.getOwnPropertyNames(raw)) {
        if (!["cpuClass", "memoryClass", "durationClass"].includes(key)) {
            throw fail(REASONS.UNKNOWN_FIELD, `unknown resources field '${key}'`);
        }
    }
    for (const [key, allowed] of [["cpuClass", RESOURCE_CLASSES], ["memoryClass", RESOURCE_CLASSES], ["durationClass", DURATION_CLASSES]]) {
        const v = raw[key];
        if (v === undefined) continue;
        if (typeof v !== "string" || !allowed.has(v)) {
            throw fail(REASONS.MALFORMED_INPUT, `resources.${key} must be one of ${[...allowed].join("|")}`);
        }
        out[key] = v;
    }
    return deepFreeze(out);
}

function parseConfigurationDescriptor(raw) {
    if (raw === undefined) return deepFreeze({});
    if (!isPlainObject(raw)) {
        throw fail(REASONS.MALFORMED_INPUT, "'configuration' must be a plain object descriptor");
    }
    assertNoDangerousKeys(raw, "configuration");
    let serialized;
    try {
        serialized = JSON.stringify(raw);
    } catch {
        throw fail(REASONS.MALFORMED_INPUT, "'configuration' is not JSON-representable");
    }
    if (serialized.length > BOUNDS.MAX_CONFIG_BYTES) {
        throw fail(REASONS.BOUND_EXCEEDED,
            `'configuration' exceeds ${BOUNDS.MAX_CONFIG_BYTES} bytes`, { bytes: serialized.length });
    }
    // round-trip through JSON to detach any exotic own-property machinery
    return deepFreeze(JSON.parse(serialized));
}

function parseRuntimeCompatibility(raw) {
    if (raw === undefined) return deepFreeze({});
    if (!isPlainObject(raw)) throw fail(REASONS.MALFORMED_INPUT, "'runtime' must be an object");
    const out = {};
    // `aether` = ejaan LAMA dari `damar` (pra-rename). Diterima sebagai
    // jalur migrasi lalu DINORMALKAN ke kunci kanonik, jadi descriptor
    // tetap memiliki satu nama saja — bukan dua identitas runtime.
    for (const key of Object.getOwnPropertyNames(raw)) {
        if (!["damar", "aether", "node"].includes(key)) {
            throw fail(REASONS.UNKNOWN_FIELD, `unknown runtime field '${key}'`);
        }
        const v = raw[key];
        if (v === undefined) continue;
        if (typeof v !== "string") throw fail(REASONS.INVALID_VERSION_RANGE, `runtime.${key} must be string range`);
        probeRange(v);
        out[key === "aether" ? "damar" : key] = v.trim();
    }
    // Kanonik menang bila keduanya ditulis, apa pun urutan kuncinya.
    if (typeof raw.damar === "string") out.damar = raw.damar.trim();
    return deepFreeze(out);
}

function parseEntrypoint(raw) {
    if (raw === undefined) return null;
    if (!isPlainObject(raw)) throw fail(REASONS.MALFORMED_INPUT, "'entrypoint' must be an object");
    for (const key of Object.getOwnPropertyNames(raw)) {
        if (!["kind", "path"].includes(key)) {
            throw fail(REASONS.UNKNOWN_FIELD, `unknown entrypoint field '${key}'`);
        }
    }
    const kind = raw.kind === undefined ? "none" : raw.kind;
    if (typeof kind !== "string" || !["module", "script", "none"].includes(kind)) {
        throw fail(REASONS.MALFORMED_INPUT, "entrypoint.kind must be module|script|none");
    }
    let p = null;
    if (raw.path !== undefined) {
        if (typeof raw.path !== "string") throw fail(REASONS.MALFORMED_INPUT, "entrypoint.path must be string");
        const candidate = raw.path.trim();
        if (candidate.length > BOUNDS.MAX_ENTRY_PATH_CHARS) {
            throw fail(REASONS.BOUND_EXCEEDED, "entrypoint.path too long");
        }
        if (candidate.includes("..") || candidate.startsWith("/") || candidate.includes("\\") ||
            /^[A-Za-z]:/.test(candidate) || candidate.includes("\u0000")) {
            throw fail(REASONS.MALFORMED_INPUT, "entrypoint.path must be a safe relative path",
                { received: candidate.slice(0, 80) });
        }
        if (!/^[A-Za-z0-9._/@-]+$/.test(candidate)) {
            throw fail(REASONS.MALFORMED_INPUT, "entrypoint.path violates safe-path grammar");
        }
        p = candidate;
    }
    return deepFreeze({ kind, path: p });
}

/**
 * Parse + validate an untrusted manifest. Accepts:
 *   - a plain object
 *   - a JSON string (bounded)
 *   - a Buffer/Uint8Array of JSON (bounded)
 * Returns a frozen canonical descriptor. Throws ExtensionKernelError on any
 * rejection. Never executes code, never requires modules, never fetches.
 */
function parseExtensionManifest(input, { source = "inline", nowMs = null } = {}) {
    let body = input;
    if (typeof input === "string" || input instanceof Uint8Array) {
        const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
        if (Buffer.byteLength(text, "utf8") > BOUNDS.MAX_MANIFEST_BYTES) {
            throw fail(REASONS.MANIFEST_TOO_LARGE,
                `manifest exceeds ${BOUNDS.MAX_MANIFEST_BYTES} bytes`,
                { bytes: Buffer.byteLength(text, "utf8") });
        }
        try {
            body = JSON.parse(text);
        } catch {
            throw fail(REASONS.MALFORMED_JSON, "manifest is not valid JSON", { source });
        }
    }
    if (!isPlainObject(body)) {
        throw fail(REASONS.MALFORMED_INPUT, `manifest must be a JSON object, got ${Array.isArray(body) ? "array" : typeof body}`);
    }

    assertNoDangerousKeys(body, "");

    const schemaVersion = body.schemaVersion;
    if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw fail(REASONS.UNSUPPORTED_SCHEMA,
            `unsupported manifest schemaVersion: ${JSON.stringify(schemaVersion) ?? "undefined"}`,
            { expected: MANIFEST_SCHEMA_VERSION });
    }

    const KNOWN_FIELDS = [
        "schemaVersion", "extensionId", "name", "version", "description", "category",
        "capabilities", "dependencies", "authorityRequirements", "resources",
        "configuration", "projects", "runtime", "entrypoint", "trusted"
    ];
    for (const key of Object.getOwnPropertyNames(body)) {
        if (!KNOWN_FIELDS.includes(key)) {
            throw fail(REASONS.UNKNOWN_FIELD, `unknown manifest field '${key}'`);
        }
    }

    const id = createExtensionId(requireString(body.extensionId, "extensionId", 128));
    const idView = deepFreeze({ kind: "ExtensionId", value: id.value }); // plain data: clone-safe
    const displayName = requireString(body.name, "name", BOUNDS.MAX_NAME_CHARS);
    const version = parseVersion(requireString(body.version, "version", 32));
    const description = requireString(body.description, "description", BOUNDS.MAX_DESCRIPTION_CHARS, { optional: true }) ?? "";

    let category = body.category === undefined ? "general" : body.category;
    if (typeof category !== "string" || !CATEGORIES.has(category)) {
        throw fail(REASONS.MALFORMED_INPUT, `category must be one of ${[...CATEGORIES].join("|")}`);
    }

    const capList = boundedList(body.capabilities, "capabilities", BOUNDS.MAX_CAPABILITIES);
    const capabilities = deepFreeze([...new Set(capList.map((c) => canonicalCapabilityName(c)))].sort());

    const dependencies = parseDependencies(body.dependencies);

    const authList = boundedList(body.authorityRequirements, "authorityRequirements", BOUNDS.MAX_AUTHORITY_REQUIREMENTS);
    const authorityRequirements = deepFreeze(
        [...new Set(authList.map((c) => canonicalCapabilityName(c)))].sort());

    const resourceExpectations = parseResourceExpectations(body.resources);
    const configuration = parseConfigurationDescriptor(body.configuration);

    const projList = boundedList(body.projects, "projects", BOUNDS.MAX_PROJECTS);
    const projects = deepFreeze(
        [...new Set(projList.map((p) => createProjectId(p).value))].sort());

    const runtime = parseRuntimeCompatibility(body.runtime);
    const entrypoint = parseEntrypoint(body.entrypoint);

    // Informational ONLY. Recorded so audits can observe the claim; it can
    // never influence kernel behavior, authority, or execution.
    let declaresTrusted = false;
    if (body.trusted !== undefined) {
        if (typeof body.trusted !== "boolean") {
            throw fail(REASONS.MALFORMED_INPUT, "'trusted' must be boolean when present");
        }
        declaresTrusted = body.trusted;
    }

    return deepFreeze({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        id: idView,
        displayName,
        version,
        description,
        category,
        capabilities,
        dependencies,
        authorityRequirements,
        resourceExpectations,
        configuration,
        projects,
        runtime,
        entrypoint,
        declaresTrusted,
        source,
        parsedAtMs: nowMs
    });
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) {
            deepFreeze(obj[key]);
        }
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { parseExtensionManifest, MANIFEST_SCHEMA_VERSION, BOUNDS, CATEGORIES };
