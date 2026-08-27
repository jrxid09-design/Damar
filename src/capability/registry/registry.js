"use strict";

/**
 * CAPABILITY REGISTRY V1 — CapabilityRegistry (canonical state owner).
 *
 * The single owner of canonical capability descriptions, provenance,
 * dependency relationships, and runtime availability observations.
 *
 * DESCRIPTIVE ONLY. This registry NEVER:
 *   - grants, ratifies, delegates, approves, or authorizes
 *   - executes, invokes, dispatches, or actuates anything
 *   - mints Authority state
 *   - alters Governor state
 *
 * Laws:
 *   available != authorized        registered != authorized
 *   trusted != authorized          provenance is evidence only
 *
 * All mutation validates FIRST and mutates SECOND: a rejected operation
 * leaves canonical state byte-identical (no partial indexes, no reverse-edge
 * residue).
 *
 * Duplicate policy: a duplicate id with materially different provenance is
 * rejected as a typed conflict; a duplicate id with identical provenance AND
 * an identical descriptor is a deterministic idempotent no-op. No
 * last-writer-wins privilege confusion.
 *
 * Availability is generation-aware: a stale (older-generation) observation
 * is rejected and can never overwrite a newer observation.
 */

const { fail, REASONS } = require("./errors");
const { parseCapabilityDescriptor } = require("./descriptor");
const { canonicalCapabilityId, canonicalProvenance } = require("./ids");
const { canonicalKind } = require("./kinds");
const { canonicalAvailability } = require("./availability");
const { wouldCreateCycle, collectAllCycles, resolveDependencyStatus, transitiveDependencies, GRAPH_BOUNDS } = require("./graph");

const DEFAULTS = Object.freeze({
    maxCapabilities: 1024
});

class CapabilityRegistry {
    constructor({ clock = { nowMs: () => Date.now() }, maxCapabilities } = {}) {
        this._clock = clock;
        this._maxCapabilities = maxCapabilities ?? DEFAULTS.maxCapabilities;
        /** @type {Map<string, object>} id -> { descriptor, availability, generation, observedAtMs } */
        this._records = new Map();
        // structural indexes (kept consistent atomically)
        this._edges = new Map();          // id -> Set<dependency ids>
        this._reverseEdges = new Map();   // depId -> Set<ids that depend on it>
        this._byKind = new Map();         // kind -> Set<id>
        this._byProvenance = new Map();   // provenance -> Set<id>
    }

    _now() {
        try { return this._clock.nowMs(); } catch { return null; }
    }

    /** Deep-frozen detached view: callers can never reach internals. */
    _frozenView(value) {
        return value === undefined ? undefined : deepFreeze(structuredClone(value));
    }

    // ------------------------------------------------------------- register

    /**
     * Register a descriptor. Untrusted input is parsed/canonicalized exactly
     * once. Validation (schema, duplicate, dependency, cycle, bounds) runs
     * BEFORE any mutation.
     */
    register(descriptorInput, { source = "inline", availability, generation } = {}) {
        const descriptor = parseCapabilityDescriptor(descriptorInput, { source, nowMs: this._now() });
        const id = descriptor.id;

        if (this._records.has(id)) {
            const existing = this._records.get(id);
            if (existing.descriptor.provenance !== descriptor.provenance) {
                throw fail(REASONS.DUPLICATE_CONFLICT,
                    `capability '${id}' already registered from different provenance`,
                    { id, existingProvenance: existing.descriptor.provenance, newProvenance: descriptor.provenance });
            }
            if (canonicalDescriptorKey(existing.descriptor) === canonicalDescriptorKey(descriptor)) {
                // identical id + provenance + descriptor => idempotent no-op
                return Object.freeze({ registered: false, idempotent: true, id });
            }
            throw fail(REASONS.DUPLICATE_CONFLICT,
                `capability '${id}' already registered with a materially different descriptor`,
                { id, provenance: descriptor.provenance });
        }
        if (this._records.size >= this._maxCapabilities) {
            throw fail(REASONS.REGISTRY_FULL, `registry bound reached (${this._maxCapabilities})`, { maxCapabilities: this._maxCapabilities });
        }

        // Dependency validation (read-only). Note: a MISSING dependency is
        // permitted at registration — a capability may describe a dependency
        // on something not yet registered; it is surfaced by
        // resolveDependencyStatus, not rejected here. Only cycles are
        // rejected below.
        const deps = descriptor.dependencies;
        for (const depId of deps) {
            if (wouldCreateCycle(this._edges, id, depId)) {
                throw fail(REASONS.DEPENDENCY_CYCLE,
                    `registering '${id}' would create a dependency cycle via '${depId}'`,
                    { id, depId });
            }
        }

        // ---- mutate (atomic, after all validation) ----
        const rec = {
            descriptor,
            availability: availability === undefined ? "UNKNOWN" : canonicalAvailability(availability),
            generation: Number.isInteger(generation) ? generation : 0,
            observedAtMs: this._now()
        };
        this._records.set(id, rec);
        this._insertIndexes(id, descriptor, deps);

        return Object.freeze({ registered: true, idempotent: false, id });
    }

    _insertIndexes(id, descriptor, deps) {
        this._edges.set(id, new Set(deps));
        for (const depId of deps) {
            if (!this._reverseEdges.has(depId)) this._reverseEdges.set(depId, new Set());
            this._reverseEdges.get(depId).add(id);
        }
        if (!this._byKind.has(descriptor.kind)) this._byKind.set(descriptor.kind, new Set());
        this._byKind.get(descriptor.kind).add(id);
        if (!this._byProvenance.has(descriptor.provenance)) this._byProvenance.set(descriptor.provenance, new Set());
        this._byProvenance.get(descriptor.provenance).add(id);
    }

    _removeIndexes(id) {
        const deps = this._edges.get(id);
        if (deps) {
            for (const depId of deps) {
                const rev = this._reverseEdges.get(depId);
                if (rev) { rev.delete(id); if (rev.size === 0) this._reverseEdges.delete(depId); }
            }
        }
        this._edges.delete(id);
        const rec = this._records.get(id);
        if (rec) {
            const kindSet = this._byKind.get(rec.descriptor.kind);
            if (kindSet) { kindSet.delete(id); if (kindSet.size === 0) this._byKind.delete(rec.descriptor.kind); }
            const provSet = this._byProvenance.get(rec.descriptor.provenance);
            if (provSet) { provSet.delete(id); if (provSet.size === 0) this._byProvenance.delete(rec.descriptor.provenance); }
        }
    }

    // --------------------------------------------------------------- remove

    /**
     * Remove a descriptor where allowed: only if no other registered
     * capability depends on it. Otherwise reject with INVALID_DEPENDENCY,
     * leaving state untouched.
     */
    remove(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this._records.has(id)) {
            throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        }
        const dependents = this._reverseEdges.get(id);
        if (dependents && dependents.size > 0) {
            throw fail(REASONS.INVALID_DEPENDENCY,
                `cannot remove '${id}': still depended on by ${[...dependents].sort().join(", ")}`,
                { id, dependents: [...dependents].sort() });
        }
        this._removeIndexes(id);
        this._records.delete(id);
        return Object.freeze({ removed: true, id });
    }

    // -------------------------------------------------------------- queries

    get(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this._records.get(id);
        if (!rec) return null;
        return this._frozenView(this._publicView(rec));
    }

    has(idOrRaw) {
        try { return this._records.has(canonicalCapabilityId(idOrRaw)); } catch { return false; }
    }

    get size() { return this._records.size; }

    list() {
        return Object.freeze([...this._records.keys()].sort().map((k) => this._frozenView(this._publicView(this._records.get(k)))));
    }

    listByKind(kindRaw) {
        const kind = canonicalKind(kindRaw);
        const ids = this._byKind.get(kind) ?? new Set();
        return Object.freeze([...ids].sort().map((k) => this._frozenView(this._publicView(this._records.get(k)))));
    }

    listByProvenance(provenanceRaw) {
        const provenance = canonicalProvenance(provenanceRaw);
        const ids = this._byProvenance.get(provenance) ?? new Set();
        return Object.freeze([...ids].sort().map((k) => this._frozenView(this._publicView(this._records.get(k)))));
    }

    listBySource(sourceRaw) {
        const source = String(sourceRaw);
        const ids = [];
        for (const [k, rec] of this._records) {
            if (rec.descriptor.source === source) ids.push(k);
        }
        return Object.freeze(ids.sort().map((k) => this._frozenView(this._publicView(this._records.get(k)))));
    }

    // -------------------------------------------------- dependency lookup

    getDependencies(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this._records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze([...(this._edges.get(id) ?? new Set())].sort());
    }

    getDependents(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        return Object.freeze([...(this._reverseEdges.get(id) ?? new Set())].sort());
    }

    resolveDependencyStatus(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this._records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        const deps = this._edges.get(id) ?? new Set();
        return resolveDependencyStatus([...deps], (depId) => {
            const rec = this._records.get(depId);
            return rec ? { availability: rec.availability } : null;
        });
    }

    /** Bounded forward transitive closure (all reachable ids). */
    transitiveDependencies(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        if (!this._records.has(id)) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze(transitiveDependencies(this._edges, id));
    }

    findAllDependencyCycles() {
        return collectAllCycles(this._edges);
    }

    // ------------------------------------------------- availability observe

    /**
     * Observe availability. Generation-aware: a stale (older) generation is
     * rejected and can never overwrite a newer observation. Availability is
     * descriptive evidence only — it grants nothing.
     */
    observeAvailability(idOrRaw, availabilityRaw, { generation, observedAtMs = null } = {}) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this._records.get(id);
        if (!rec) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        const availability = canonicalAvailability(availabilityRaw);

        if (Number.isInteger(generation)) {
            if (generation < rec.generation) {
                throw fail(REASONS.STALE_OBSERVATION,
                    `stale availability observation for '${id}' (generation ${generation} < current ${rec.generation})`,
                    { id, generation, current: rec.generation });
            }
            if (generation === rec.generation && rec.availability === availability) {
                return Object.freeze({ changed: false, id, availability, generation: rec.generation });
            }
        }

        rec.availability = availability;
        if (Number.isInteger(generation)) rec.generation = generation;
        rec.observedAtMs = observedAtMs ?? this._now();
        return Object.freeze({ changed: true, id, availability, generation: rec.generation });
    }

    getAvailability(idOrRaw) {
        const id = canonicalCapabilityId(idOrRaw);
        const rec = this._records.get(id);
        if (!rec) throw fail(REASONS.UNKNOWN_CAPABILITY, `unknown capability '${id}'`, { id });
        return Object.freeze({ availability: rec.availability, generation: rec.generation, observedAtMs: rec.observedAtMs });
    }

    // -------------------------------------------------------------- helpers

    _publicView(rec) {
        return { ...rec.descriptor, availability: rec.availability, generation: rec.generation, observedAtMs: rec.observedAtMs };
    }

    /** Deterministic serialization of canonical state (no live objects). */
    serialize() {
        const records = [];
        for (const k of [...this._records.keys()].sort()) {
            const rec = this._records.get(k);
            records.push({
                ...JSON.parse(JSON.stringify(rec.descriptor)),
                availability: rec.availability,
                generation: rec.generation,
                observedAtMs: rec.observedAtMs
            });
        }
        return deepFreeze({ schemaVersion: 1, capabilities: records });
    }

    getStats() {
        return Object.freeze({
            capabilities: this._records.size,
            maxCapabilities: this._maxCapabilities,
            edges: countSets(this._edges),
            reverseEdges: countSets(this._reverseEdges)
        });
    }
}

function countSets(map) {
    let n = 0;
    for (const set of map.values()) n += set.size;
    return n;
}

function canonicalDescriptorKey(descriptor) {
    return JSON.stringify([
        descriptor.schemaVersion, descriptor.id, descriptor.kind, descriptor.provider,
        descriptor.source, descriptor.operations, descriptor.requirements, descriptor.effects,
        descriptor.provenance, descriptor.dependencies, descriptor.metadata, descriptor.description
    ]);
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) deepFreeze(obj[key]);
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { CapabilityRegistry, DEFAULTS };
