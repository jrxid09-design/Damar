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
// caller-supplied strings. Both the registrar-mint capability and the
// established-identity capability are represented by tokens created in this
// module's closure, compared by identity (===), and NEVER exported.
//
//   MINT_TOKEN         — gates registrar minting (WeakMap mintGates)
//   identityTokens     — WeakSet of genuine established-identity tokens
//
// A caller cannot forge these by constructing an object, guessing a string,
// importing an exported symbol, or cloning an existing descriptor/context:
//   - Symbol("aether.capability.registrar.mint") !== MINT_TOKEN (identity)
//   - a structurally identical object is a different identity
//   - cloned objects are different identities
// ---------------------------------------------------------------------------

const MINT_TOKEN = Symbol("aether.capability.registrar.mint");
const mintGates = new WeakMap();          // CapabilityRegistry -> mint gate fn
const identityTokens = new WeakSet();     // genuine established-identity tokens

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

    constructor({ clock = { nowMs: () => Date.now() }, maxCapabilities } = {}) {
        this._clock = clock;
        this._maxCapabilities = maxCapabilities ?? DEFAULTS.maxCapabilities;

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

    _now() {
        try { return this._clock.nowMs(); } catch { return null; }
    }

    // ------------------------------------------------------ private admission

    #admit(descriptorInput, provenance, { serializedOnly } = {}) {
        const isSerialized = typeof descriptorInput === "string" || descriptorInput instanceof Uint8Array;
        if (serializedOnly && !isSerialized) {
            throw fail(REASONS.OBJECT_INPUT_NOT_ALLOWED,
                "untrusted registration requires bounded serialized JSON (string or Uint8Array); object input is only accepted via the trusted registrar boundary");
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
        if (this.#records.size >= this._maxCapabilities) {
            throw fail(REASONS.REGISTRY_FULL, `registry bound reached (${this._maxCapabilities})`, { maxCapabilities: this._maxCapabilities });
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

        // observedAtMs must be a finite number (or absent, in which case the
        // trusted registry clock produces it). Reject functions/objects/etc.
        if (observedAtMs !== null && observedAtMs !== undefined) {
            if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs)) {
                throw fail(REASONS.MALFORMED_INPUT,
                    `observedAtMs must be a finite number, got ${describeNumber(observedAtMs)}`,
                    { id });
            }
        }
        const nextObservedAtMs = observedAtMs ?? this._now();

        if (generation < rec.generation) {
            throw fail(REASONS.STALE_OBSERVATION,
                `stale availability observation for '${id}' (generation ${generation} < current ${rec.generation})`,
                { id, generation, current: rec.generation });
        }

        if (generation === rec.generation) {
            const identical = rec.availability === availability
                && stableEquals(rec.observation, nextMetadata)
                && rec.observedAtMs === nextObservedAtMs;
            if (identical) {
                return Object.freeze({ changed: false, id, availability, generation: rec.generation, incarnationId: rec.incarnationId });
            }
            throw fail(REASONS.CONFLICTING_OBSERVATION,
                `conflicting availability observation for '${id}' at generation ${generation}`,
                { id, generation, currentAvailability: rec.availability, newAvailability: availability });
        }

        // generation > current => valid atomic update
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
            maxCapabilities: this._maxCapabilities,
            edges: countSets(this.#edges),
            reverseEdges: countSets(this.#reverseEdges)
        });
    }
}

// ---------------------------------------------------------------------------
// Established-identity capability + registrar factory (composition root).
//
// These live in the same module closure as MINT_TOKEN and identityTokens, so
// they can mint registrars and identities WITHOUT exporting any token. This is
// the runtime-owned composition boundary: trusted runtime code calls
// createCapabilityRegistrarFactory(registry) once at startup and hands
// consumers ONLY the bound registrar (never the factory, never the token).
// ---------------------------------------------------------------------------

/**
 * Establish a trusted identity for a provenance domain. Returns an opaque,
 * unforgeable identity token (an object identity held in the module-closure
 * identityTokens WeakSet). Only the owning subsystem, already in possession of
 * an established identity, should produce the corresponding registrar.
 *
 * `domain` must be one of "core" | "extension" | "device" | "provider"; the
 * `registrarId` is required for non-core domains.
 */
function establishIdentity(domain, registrarId) {
    const token = { domain, registrarId };
    identityTokens.add(token);
    return Object.freeze(token);
}

function isEstablishedIdentity(token, domain) {
    if (token === null || typeof token !== "object") return false;
    if (!identityTokens.has(token)) return false;
    return token.domain === domain;
}

/**
 * Create the registrar factory bound to `registry`. The factory is the ONLY
 * holder of the registrar-mint capability for that registry (via MINT_TOKEN in
 * closure). It mints registrars only for identities that were established via
 * establishIdentity — never from caller-supplied strings.
 */
function createCapabilityRegistrarFactory(registry) {
    const gate = mintGates.get(registry);
    if (typeof gate !== "function") {
        throw fail(REASONS.INVALID_REGISTRAR,
            "createCapabilityRegistrarFactory requires a valid CapabilityRegistry instance");
    }

    const mint = (domain, registrarId) => gate(MINT_TOKEN, domain, registrarId);

    return Object.freeze({
        createCoreRegistrar(runtimeIdentity) {
            if (!isEstablishedIdentity(runtimeIdentity, "core")) {
                throw fail(REASONS.INVALID_REGISTRAR,
                    "core registrar requires a runtime-owned established identity");
            }
            return mint("core");
        },
        createExtensionRegistrar(establishedIdentity) {
            if (!isEstablishedIdentity(establishedIdentity, "extension")) {
                throw fail(REASONS.INVALID_REGISTRAR,
                    "extension registrar requires an established extension identity");
            }
            return mint("extension", establishedIdentity.registrarId);
        },
        createDeviceRegistrar(establishedIdentity) {
            if (!isEstablishedIdentity(establishedIdentity, "device")) {
                throw fail(REASONS.INVALID_REGISTRAR,
                    "device registrar requires an established device identity");
            }
            return mint("device", establishedIdentity.registrarId);
        },
        createProviderRegistrar(establishedIdentity) {
            if (!isEstablishedIdentity(establishedIdentity, "provider")) {
                throw fail(REASONS.INVALID_REGISTRAR,
                    "provider registrar requires an established provider identity");
            }
            return mint("provider", establishedIdentity.registrarId);
        }
    });
}

module.exports = {
    CapabilityRegistry,
    DEFAULTS,
    createCapabilityRegistrarFactory,
    establishIdentity
};
