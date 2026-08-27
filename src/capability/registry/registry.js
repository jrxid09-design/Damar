"use strict";

/**
 * CAPABILITY REGISTRY V1 — CapabilityRegistry (canonical state owner).
 *
 * DESCRIPTIVE ONLY. This registry NEVER grants/authorizes/executes/actuates,
 * never mints Authority state, and never alters Governor state.
 *
 * available != authorized ; trusted != authorized ; provenance is evidence.
 *
 * LIFETIME MODEL:
 *   capabilityId  = logical identity (stable across remove/re-register)
 *   incarnationId = registry-minted lifetime identity (fresh every register)
 *   generation    = ordering only inside one incarnation
 *
 * Observations MUST carry the exact current incarnationId; a prior-lifetime
 * observation is always rejected regardless of generation (ABA-safe).
 *
 * PROVENANCE MODEL: owned by registrars (runtime-created), never descriptors.
 *
 * STATE PRIVACY: all canonical mutable internals are true JS private fields.
 * Public getters/lists return detached inert snapshots.
 */

const crypto = require("node:crypto");

const { fail, REASONS } = require("./errors");
const { parseCapabilityDescriptor, parseObservationMetadata } = require("./descriptor");
const { canonicalCapabilityId } = require("./ids");
const { canonicalKind } = require("./kinds");
const { canonicalAvailability } = require("./availability");
const { wouldCreateCycle, collectAllCycles, resolveDependencyStatus, transitiveDependencies } = require("./graph");
const { createRegistrar, assertKindDomainCorrespondence } = require("./registrar");

const DEFAULTS = Object.freeze({ maxCapabilities: 1024 });

// ---------------------------------------------------------------------------
// Registrar mint trust model (unforgeable capability).
//
// Trust derives from possession of an unforgeable capability token, NOT from
// caller-supplied strings. The registrar-mint capability is represented by a
// token created in this module's closure, compared by identity (===), and
// NEVER exported.
//
//   MINT_TOKEN  — gates registrar minting (WeakMap mintGates)
//
// A caller cannot forge the token by constructing an object, guessing a
// string, importing an exported symbol, or cloning an existing context:
//   - Symbol("aether.capability.registrar.mint") !== MINT_TOKEN (identity)
//   - a structurally identical object is a different identity
// ---------------------------------------------------------------------------

const MINT_TOKEN = Symbol("aether.capability.registrar.mint");
const mintGates = new WeakMap();          // CapabilityRegistry -> mint gate fn

const INCARNATION_PREFIX = "inc-";
const INCARNATION_PATTERN = /^inc-[0-9a-f]{32}$/;

function mintIncarnationId() {
    return `${INCARNATION_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
}

function isValidIncarnationId(value) {
    return typeof value === "string" && INCARNATION_PATTERN.test(value);
}

/** Map a registrar provenance to its closed trust domain. */
function domainOf(provenance) {
    if (provenance === "core/runtime" || provenance === "system") return "core";
    const colon = provenance.indexOf(":");
    return colon === -1 ? "core" : provenance.slice(0, colon);
}

function describeNumber(v) {
    if (typeof v === "number") return String(v);
    return typeof v;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

/** Detached deep-copy + deep-freeze of canonical plain data. */
function frozenView(value) {
    return value === undefined ? undefined : deepFreeze(structuredClone(value));
}

function stableEquals(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function canonicalDescriptorKey(descriptor) {
    return JSON.stringify([
        descriptor.schemaVersion, descriptor.id, descriptor.kind, descriptor.provider,
        descriptor.source, descriptor.operations, descriptor.requirements, descriptor.effects,
        descriptor.provenance, descriptor.dependencies, descriptor.metadata, descriptor.description
    ]);
}

function countSets(map) {
    let n = 0;
    for (const set of map.values()) n += set.size;
    return n;
}

class CapabilityRegistry {
    #records = new Map();
    #edges = new Map();
    #reverseEdges = new Map();
    #byKind = new Map();
    #byProvenance = new Map();
    #clock;
    #maxCapabilities;

    constructor({ clock = { nowMs: () => Date.now() }, maxCapabilities } = {}) {
        // Capture the trusted clock function immutably. We never retain the
        // caller's mutable clock object; only a bound `nowMs` function is kept,
        // and its result is validated on every call.
        const nowMs = (clock && typeof clock.nowMs === "function")
            ? () => clock.nowMs()
            : () => Date.now();
        this.#clock = Object.freeze({ nowMs });
        this.#maxCapabilities = maxCapabilities ?? DEFAULTS.maxCapabilities;

        // Register the token-gated mint gate for this instance in module
        // closure. It is NOT a property on the instance: arbitrary code cannot
        // enumerate or reach it, and it rejects any token !== MINT_TOKEN.
        mintGates.set(this, (token, domain, registrarId) => {
            if (token !== MINT_TOKEN) {
                throw fail(REASONS.INVALID_REGISTRAR,
                    "forged registrar mint token; registrar creation requires a runtime-owned capability");
            }
            return createRegistrar((descriptorInput, provenance, opts) => {
                return this.#admit(descriptorInput, provenance, opts);
            }, { domain, registrarId });
        });
    }

    /**
     * Produce a validated timestamp. The clock result MUST be a finite,
     * nonnegative safe integer (milliseconds). Any other result (NaN, Infinity,
     * function, object, string, negative) throws BEFORE any mutation.
     */
    _now() {
        const raw = this.#clock.nowMs();
        if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw < 0) {
            throw fail(REASONS.MALFORMED_INPUT,
                `clock returned an invalid timestamp (${describeNumber(raw)}); expected a nonnegative safe integer ms`);
        }
        return raw;
    }

    // ------------------------------------------------------ private admission

    #admit(descriptorInput, provenance, { serializedOnly } = {}) {
        // Untrusted boundary is STRING-ONLY. Reject every non-string (object,
        // function, symbol, array, typed array, etc.) via a primitive typeof
        // check that performs NO reflective inspection (no instanceof, no
        // property access) so a Proxy cannot execute getPrototypeOf/get/ownKeys/
        // getOwnPropertyDescriptor traps during rejection.
        if (serializedOnly && typeof descriptorInput !== "string") {
            throw fail(REASONS.OBJECT_INPUT_NOT_ALLOWED,
                "untrusted registration requires a serialized JSON string; object input is only accepted via the trusted registrar boundary");
        }

        const descriptor = parseCapabilityDescriptor(descriptorInput, { source: provenance, nowMs: this._now() });

        // kind/provenance correspondence must hold before any mutation.
        assertKindDomainCorrespondence(descriptor.kind, domainOf(provenance));

        // Bake authoritative (registrar-owned) provenance into the record.
        const canonical = deepFreeze({ ...descriptor, provenance: Object.freeze(provenance) });
        const id = canonical.id;

        if (this.#records.has(id)) {
            const existing = this.#records.get(id);
            if (existing.descriptor.provenance !== canonical.provenance) {
                throw fail(REASONS.DUPLICATE_CONFLICT,
                    `capability '${id}' already registered from different provenance`,
                    { id, existingProvenance: existing.descriptor.provenance, newProvenance: canonical.provenance });
            }
            if (canonicalDescriptorKey(existing.descriptor) === canonicalDescriptorKey(canonical)) {
                return Object.freeze({
                    registered: false, idempotent: true, id,
                    incarnationId: existing.incarnationId, generation: existing.generation
                });
            }
            throw fail(REASONS.DUPLICATE_CONFLICT,
                `capability '${id}' already registered with a materially different descriptor`,
                { id, provenance: canonical.provenance });
        }
        if (this.#records.size >= this.#maxCapabilities) {
            throw fail(REASONS.REGISTRY_FULL, `registry bound reached (${this.#maxCapabilities})`, { maxCapabilities: this.#maxCapabilities });
        }

        const deps = canonical.dependencies;
        for (const depId of deps) {
            if (wouldCreateCycle(this.#edges, id, depId)) {
                throw fail(REASONS.DEPENDENCY_CYCLE,
                    `registering '${id}' would create a dependency cycle via '${depId}'`,
                    { id, depId });
            }
        }

        // ---- mutate (atomic, after all validation) ----
        const incarnationId = mintIncarnationId();
        const rec = {
            descriptor: canonical,
            incarnationId,
            availability: "UNKNOWN",
            generation: 0,
            observedAtMs: this._now(),
            observation: Object.freeze({})
        };
        this.#records.set(id, rec);
        this.#insertIndexes(id, canonical, deps);

        return Object.freeze({ registered: true, idempotent: false, id, incarnationId, generation: 0 });
    }

    #insertIndexes(id, descriptor, deps) {
        this.#edges.set(id, new Set(deps));
        for (const depId of deps) {
            if (!this.#reverseEdges.has(depId)) this.#reverseEdges.set(depId, new Set());
            this.#reverseEdges.get(depId).add(id);
        }
        if (!this.#byKind.has(descriptor.kind)) this.#byKind.set(descriptor.kind, new Set());
        this.#byKind.get(descriptor.kind).add(id);
        if (!this.#byProvenance.has(descriptor.provenance)) this.#byProvenance.set(descriptor.provenance, new Set());
        this.#byProvenance.get(descriptor.provenance).add(id);
    }

    #removeIndexes(id) {
        const deps = this.#edges.get(id);
        if (deps) {
            for (const depId of deps) {
                const rev = this.#reverseEdges.get(depId);
                if (rev) { rev.delete(id); if (rev.size === 0) this.#reverseEdges.delete(depId); }
            }
        }
        this.#edges.delete(id);
        const rec = this.#records.get(id);
        if (rec) {
            const kindSet = this.#byKind.get(rec.descriptor.kind);
            if (kindSet) { kindSet.delete(id); if (kindSet.size === 0) this.#byKind.delete(rec.descriptor.kind); }
            const provSet = this.#byProvenance.get(rec.descriptor.provenance);
            if (provSet) { provSet.delete(id); if (provSet.size === 0) this.#byProvenance.delete(rec.descriptor.provenance); }
        }
    }

    // --------------------------------------------------------------- remove

    remove(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this.#records.has(id)) {
            throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        }
        const dependents = this.#reverseEdges.get(id);
        if (dependents && dependents.size > 0) {
            throw fail(REASONS.INVALID_DEPENDENCY,
                `cannot remove '${id}': still depended on by ${[...dependents].sort().join(", ")}`,
                { id, dependents: [...dependents].sort() });
        }
        this.#removeIndexes(id);
        this.#records.delete(id);
        return Object.freeze({ removed: true, id });
    }

    // -------------------------------------------------------------- queries

    get(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this.#records.get(id);
        if (!rec) return null;
        return frozenView(this.#publicView(rec));
    }

    has(idOrRaw) {
        try { return this.#records.has(canonicalCapabilityId(idOrRaw)); } catch { return false; }
    }

    get size() { return this.#records.size; }

    list() {
        return Object.freeze([...this.#records.keys()].sort().map((k) => frozenView(this.#publicView(this.#records.get(k)))));
    }

    listByKind(kindRaw) {
        const kind = canonicalKind(kindRaw);
        const ids = this.#byKind.get(kind) ?? new Set();
        return Object.freeze([...ids].sort().map((k) => frozenView(this.#publicView(this.#records.get(k)))));
    }

    listByProvenance(provenanceRaw) {
        const provenance = String(provenanceRaw).trim().toLowerCase();
        const ids = [];
        for (const [k, rec] of this.#records) {
            if (rec.descriptor.provenance === provenance) ids.push(k);
        }
        return Object.freeze(ids.sort().map((k) => frozenView(this.#publicView(this.#records.get(k)))));
    }

    listBySource(sourceRaw) {
        const source = String(sourceRaw);
        const ids = [];
        for (const [k, rec] of this.#records) {
            if (rec.descriptor.source === source) ids.push(k);
        }
        return Object.freeze(ids.sort().map((k) => frozenView(this.#publicView(this.#records.get(k)))));
    }

    // -------------------------------------------------- dependency lookup

    getDependencies(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this.#records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze([...(this.#edges.get(id) ?? new Set())].sort());
    }

    getDependents(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        return Object.freeze([...(this.#reverseEdges.get(id) ?? new Set())].sort());
    }

    resolveDependencyStatus(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this.#records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        const deps = this.#edges.get(id) ?? new Set();
        return resolveDependencyStatus([...deps], (depId) => {
            const rec = this.#records.get(depId);
            return rec ? { availability: rec.availability } : null;
        });
    }

    transitiveDependencies(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this.#records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze(transitiveDependencies(this.#edges, id));
    }

    findAllDependencyCycles() {
        return collectAllCycles(this.#edges);
    }

    // ------------------------------------------------- availability observe

    observeAvailability(idOrRaw, availabilityRaw, { generation, incarnationId, observedAtMs = null, metadata } = {}) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this.#records.get(id);
        if (!rec) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });

        // lifetime identity gate (before anything else)
        if (!isValidIncarnationId(incarnationId)) {
            throw fail(REASONS.INVALID_INCARNATION,
                `availability observation for '${id}' requires the exact current incarnationId`, { id });
        }
        if (incarnationId !== rec.incarnationId) {
            throw fail(REASONS.INVALID_INCARNATION,
                `availability observation for '${id}' carries an old or unknown incarnationId`, { id });
        }

        // strict generation validation (before mutation)
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw fail(REASONS.INVALID_GENERATION,
                `generation must be a nonnegative safe integer, got ${describeNumber(generation)}`,
                { id, generation });
        }

        const availability = canonicalAvailability(availabilityRaw);
        const nextMetadata = parseObservationMetadata(metadata);

        // observedAtMs (if caller-supplied) must be a finite nonnegative safe
        // integer. It is validated but NOT persisted for equal-generation
        // comparisons (which compare semantic caller observation only).
        if (observedAtMs !== null && observedAtMs !== undefined) {
            if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
                throw fail(REASONS.MALFORMED_INPUT,
                    `observedAtMs must be a nonnegative safe integer, got ${describeNumber(observedAtMs)}`,
                    { id });
            }
        }

        if (generation < rec.generation) {
            throw fail(REASONS.STALE_OBSERVATION,
                `stale availability observation for '${id}' (generation ${generation} < current ${rec.generation})`,
                { id, generation, current: rec.generation });
        }

        if (generation === rec.generation) {
            // Equal generation: compare the SEMANTIC caller observation
            // (availability + metadata) only. Do NOT mint a new timestamp and
            // do NOT let a caller-supplied timestamp break idempotence.
            const identical = rec.availability === availability
                && stableEquals(rec.observation, nextMetadata);
            if (identical) {
                return Object.freeze({ changed: false, id, availability, generation: rec.generation, incarnationId: rec.incarnationId });
            }
            throw fail(REASONS.CONFLICTING_OBSERVATION,
                `conflicting availability observation for '${id}' at generation ${generation}`,
                { id, generation, currentAvailability: rec.availability, newAvailability: availability });
        }

        // generation > current => valid update. Synthesize the default
        // timestamp ONLY now (so equal-generation idempotent replay never
        // mints a fresh clock value).
        const nextObservedAtMs = (observedAtMs === null || observedAtMs === undefined)
            ? this._now()
            : observedAtMs;

        rec.availability = availability;
        rec.generation = generation;
        rec.observedAtMs = nextObservedAtMs;
        rec.observation = nextMetadata;
        return Object.freeze({ changed: true, id, availability, generation: rec.generation, incarnationId: rec.incarnationId });
    }

    getAvailability(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this.#records.get(id);
        if (!rec) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze({
            availability: rec.availability,
            generation: rec.generation,
            observedAtMs: rec.observedAtMs,
            incarnationId: rec.incarnationId
        });
    }

    getIncarnationId(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this.#records.get(id);
        if (!rec) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return rec.incarnationId;
    }

    // -------------------------------------------------------------- helpers

    #publicView(rec) {
        return {
            ...rec.descriptor,
            availability: rec.availability,
            generation: rec.generation,
            observedAtMs: rec.observedAtMs,
            incarnationId: rec.incarnationId
        };
    }

    serialize() {
        const records = [];
        for (const k of [...this.#records.keys()].sort()) {
            const rec = this.#records.get(k);
            records.push({
                ...JSON.parse(JSON.stringify(rec.descriptor)),
                availability: rec.availability,
                generation: rec.generation,
                observedAtMs: rec.observedAtMs,
                incarnationId: rec.incarnationId
            });
        }
        return deepFreeze({ schemaVersion: 1, capabilities: records });
    }

    getStats() {
        return Object.freeze({
            capabilities: this.#records.size,
            maxCapabilities: this.#maxCapabilities,
            edges: countSets(this.#edges),
            reverseEdges: countSets(this.#reverseEdges)
        });
    }
}

// ---------------------------------------------------------------------------
// Trusted bootstrap composition root.
//
// The registrar-mint capability and the identity-establishment capability are
// held ONLY in this module's closure. They are NEVER exported, and no
// standalone `establishIdentity` / `createCapabilityRegistrarFactory` /
// `MINT_TOKEN` symbol is reachable from any `module.exports`.
//
// The ONLY exported issuance surface is `createCapabilityRuntime`, which
// constructs a CapabilityRegistry and its bound registrars TOGETHER and returns
// only least-privilege registrars (never the mint capability, never the
// factory, never an identity-establishment callable).
//
// HONEST BOUNDARY: this is a same-process CommonJS boundary, not OS/module
// isolation. Untrusted extension/provider/device code MUST NOT execute in the
// same unrestricted require-capable context as this module. The eventual
// enforcement is module-loader allowlisting / process isolation; until then,
// the mint capability exists only in this closure and is never handed out.
// ---------------------------------------------------------------------------

function mintRegistrar(registry, domain, registrarId) {
    const gate = mintGates.get(registry);
    if (typeof gate !== "function") {
        throw fail(REASONS.INVALID_REGISTRAR,
            "registrar minting requires a valid CapabilityRegistry instance");
    }
    return gate(MINT_TOKEN, domain, registrarId);
}

/**
 * Construct a capability runtime: a CapabilityRegistry plus its bound,
 * least-privilege registrars, minted together inside the trusted bootstrap
 * closure. This is the ONLY issuance surface.
 *
 * `registrars` describes which registrars to mint:
 *   { core: true, extension: "id", device: "id", provider: "id" }
 *
 * Identities are established (and validated) INSIDE this closure via
 * establishIdentity; a caller cannot substitute a forged identity object.
 * Consumers receive only the bound registrars.
 *
 * @param {object} [options]
 * @param {object} [options.clock]          trusted clock ({ nowMs })
 * @param {number} [options.maxCapabilities]
 * @param {object} [options.registrars]     registrar specs
 */
function createCapabilityRuntime(options = {}) {
    const registry = new CapabilityRegistry({
        clock: options.clock,
        maxCapabilities: options.maxCapabilities
    });

    const spec = options.registrars ?? {};
    const registrars = {};

    if (spec.core === true) {
        registrars.core = mintRegistrar(registry, "core");
    }
    if (typeof spec.extension === "string") {
        registrars.extension = mintRegistrar(registry, "extension", spec.extension);
    }
    if (typeof spec.device === "string") {
        registrars.device = mintRegistrar(registry, "device", spec.device);
    }
    if (typeof spec.provider === "string") {
        registrars.provider = mintRegistrar(registry, "provider", spec.provider);
    }

    return Object.freeze({
        registry,
        registrars: Object.freeze(registrars)
    });
}

module.exports = {
    CapabilityRegistry,
    DEFAULTS,
    createCapabilityRuntime
};
