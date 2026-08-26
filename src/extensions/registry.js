"use strict";

/**
 * EXTENSION KERNEL V1 — ExtensionRegistry (canonical state owner).
 *
 * No shadow registries. All lifecycle mutation flows through here and only
 * through validated transitions. External views are deep-frozen copies, so
 * hostile callers cannot mutate kernel internals from returned objects.
 *
 * BOUNDARY LAWS (structurally enforced by the absence of imports):
 *   - never mints or modifies Authority (requirements are descriptive data)
 *   - never executes extension code, spawns processes, or touches network
 *   - never performs admission decisions (Resource Governor's job)
 */

const { fail, REASONS } = require("./errors");
const {
    createExtensionId, asExtensionId, idToString,
    createProjectId, asProjectId, projectToString,
    canonicalCapabilityName
} = require("./ids");
const { parseExtensionManifest, BOUNDS: MANIFEST_BOUNDS } = require("./manifest");
const {
    STATES, EVENTS, nextTarget, ACTIVE_STATES, HEALTH_REPORTABLE_STATES
} = require("./lifecycle");
const { HEALTH_STATUSES, createHealthReport } = require("./health");
const { buildDependencyReport, collectAllCycles } = require("./dependencies");

const DEFAULTS = Object.freeze({
    maxExtensions: 512,
    maxProjectActivationsPerExtension: 256
});

class ExtensionRegistry {
    constructor({ clock = { nowMs: () => Date.now() }, maxExtensions, maxProjectActivationsPerExtension } = {}) {
        this._clock = clock;
        this._maxExtensions = maxExtensions ?? DEFAULTS.maxExtensions;
        this._maxActivationsPerExt = maxProjectActivationsPerExtension ?? DEFAULTS.maxProjectActivationsPerExtension;
        /** @type {Map<string, object>} internal mutable records — never exposed raw */
        this._records = new Map();
    }

    _now() {
        try { return this._clock.nowMs(); } catch { return null; }
    }

    /** Fresh, deep-frozen copy: hostile callers can never reach internals. */
    _frozenView(value) {
        return value === undefined ? undefined : deepFreeze(structuredClone(value));
    }

    // ------------------------------------------------------------- register

    /**
     * Register a discovered/validated manifest. Untrusted input is parsed
     * here; duplicate canonical ids are rejected deterministically.
     */
    register(manifestInput, { source = "inline", install = false } = {}) {
        const descriptor = manifestInput && manifestInput.id && manifestInput.schemaVersion &&
            Object.isFrozen(manifestInput)
            ? manifestInput
            : parseExtensionManifest(manifestInput, { source });
        const idValue = descriptor.id.value;
        if (this._records.has(idValue)) {
            throw fail(REASONS.DUPLICATE_EXTENSION, `extension '${idValue}' is already registered`,
                { extensionId: idValue });
        }
        if (this._records.size >= this._maxExtensions) {
            throw fail(REASONS.REGISTRY_FULL, `registry bound reached (${this._maxExtensions})`,
                { maxExtensions: this._maxExtensions });
        }
        const now = this._now();
        const record = {
            descriptor,
            state: STATES.DISCOVERED,
            healthStatus: HEALTH_STATUSES.UNKNOWN,
            healthReport: null,
            lastTransition: Object.freeze({ from: null, to: STATES.DISCOVERED, event: "REGISTER", atMs: now }),
            projects: new Set(),
            configurationValues: undefined
        };
        this._records.set(idValue, record);
        let registered = true;
        if (install) {
            // one-shot discover+install convenience; same validated path
            this.install(descriptor.id);
        }
        return Object.freeze({ registered, id: descriptor.id, state: this._records.get(idValue).state });
    }

    _record(idOrRaw, expectedStateCheck = null) {
        const id = asExtensionId(idOrRaw) ?? createExtensionId(idOrRaw);
        const rec = this._records.get(id.value);
        if (!rec) {
            throw fail(REASONS.UNKNOWN_EXTENSION, `unknown extension '${id.value}'`, { extensionId: id.value });
        }
        return [id.value, rec];
    }

    _transition(idValue, event, targetOverride = null) {
        const rec = this._records.get(idValue);
        const target = targetOverride ?? nextTarget(rec.state, event);
        if (!target) {
            throw fail(REASONS.INVALID_TRANSITION,
                `event ${event} not allowed from state ${rec.state} for '${idValue}'`,
                { extensionId: idValue, state: rec.state, event });
        }
        const from = rec.state;
        rec.state = target;
        rec.lastTransition = Object.freeze({
            from, to: target, event, atMs: this._now()
        });
        return { from, to: target };
    }

    // ------------------------------------------------------------ lifecycle

    install(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.INSTALL);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    /**
     * Enable an installed/disabled/failed extension. Atomic: dependency gate
     * runs BEFORE any mutation. Double-enable on already-active extensions
     * is a deterministic no-op result, not an error.
     */
    enable(idOrRaw) {
        const [idValue, rec] = this._record(idOrRaw);

        if (ACTIVE_STATES.has(rec.state)) {
            return Object.freeze({ changed: false, alreadyEnabled: true, id: idValue, state: rec.state });
        }
        const target = nextTarget(rec.state, EVENTS.ENABLE);
        if (!target) {
            throw fail(REASONS.INVALID_TRANSITION,
                `ENABLE not allowed from state ${rec.state} for '${idValue}'`,
                { extensionId: idValue, state: rec.state, event: EVENTS.ENABLE });
        }

        // dependency gate (read-only) — before any mutation
        const report = this.getDependencyReport(rec.descriptor.id);
        if (!report.ok) {
            throw fail(REASONS.DEPENDENCY_UNSATISFIED,
                `cannot enable '${idValue}': required dependencies unsatisfied`,
                { extensionId: idValue, missing: report.missing, disabled: report.disabled, versionMismatch: report.versionMismatch });
        }

        this._transition(idValue, EVENTS.ENABLE, target);
        return Object.freeze({ changed: true, id: idValue, state: this._records.get(idValue).state });
    }

    /** Deterministic disable; double-disable is a safe no-op result. */
    disable(idOrRaw) {
        const [idValue, rec] = this._record(idOrRaw);
        if (rec.state === STATES.DISABLED || rec.state === STATES.INSTALLED || rec.state === STATES.DISCOVERED) {
            return Object.freeze({ changed: false, alreadyDisabled: true, id: idValue, state: rec.state });
        }
        this._transition(idValue, EVENTS.DISABLE);
        return Object.freeze({ changed: true, id: idValue, state: this._records.get(idValue).state });
    }

    start(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.START);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    completeStart(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.START_COMPLETE);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    beginStop(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.STOP_BEGIN);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    completeStop(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.STOP_COMPLETE);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    markUnavailable(idOrRaw) {
        const [id] = this._record(idOrRaw);
        this._transition(id, EVENTS.MARK_UNAVAILABLE);
        return Object.freeze({ changed: true, id, state: this._records.get(id).state });
    }

    /**
     * Trusted-lifecycle-path health update. Hostile diagnostic payloads are
     * sanitized/bounded before touching core state.
     */
    reportHealth(idOrRaw, status, diagnostics) {
        const [idValue, rec] = this._record(idOrRaw);
        if (!HEALTH_REPORTABLE_STATES.has(rec.state)) {
            throw fail(REASONS.INVALID_TRANSITION,
                `health report not accepted in state ${rec.state} for '${idValue}'`,
                { extensionId: idValue, state: rec.state });
        }
        const report = createHealthReport(status, diagnostics, { atMs: this._now() });
        const previousState = rec.state;
        rec.healthReport = report;
        rec.healthStatus = report.status;
        if (report.status === HEALTH_STATUSES.HEALTHY && previousState !== STATES.HEALTHY) {
            rec.state = STATES.HEALTHY;
            rec.lastTransition = Object.freeze({ from: previousState, to: STATES.HEALTHY, event: "HEALTH_REPORT", atMs: report.atMs });
        } else if (report.status === HEALTH_STATUSES.DEGRADED && previousState !== STATES.DEGRADED) {
            rec.state = STATES.DEGRADED;
            rec.lastTransition = Object.freeze({ from: previousState, to: STATES.DEGRADED, event: "HEALTH_REPORT", atMs: report.atMs });
        } else if (report.status === HEALTH_STATUSES.FAILED && previousState !== STATES.FAILED) {
            rec.state = STATES.FAILED;
            rec.lastTransition = Object.freeze({ from: previousState, to: STATES.FAILED, event: "HEALTH_REPORT", atMs: report.atMs });
        }
        return Object.freeze({
            changed: true, id: idValue,
            state: rec.state,
            health: report,
            stateChanged: previousState !== rec.state
        });
    }

    // --------------------------------------------------- project activation

    /** Activation requires global enablement; grants nothing else. */
    activateForProject(idOrRaw, projectOrRaw) {
        const [idValue] = this._record(idOrRaw);
        const projectId = createProjectId(projectOrRaw);
        const rec = this._records.get(idValue);
        if (!ACTIVE_STATES.has(rec.state)) {
            throw fail(REASONS.ACTIVATION_REJECTED,
                `cannot activate '${idValue}' for project while state is ${rec.state}`,
                { extensionId: idValue, state: rec.state, project: projectId.value });
        }
        if (rec.projects.has(projectId.value)) {
            return Object.freeze({ changed: false, alreadyActive: true, id: idValue, project: projectId.value });
        }
        if (rec.projects.size >= this._maxActivationsPerExt) {
            throw fail(REASONS.BOUND_EXCEEDED,
                `activation bound reached (${this._maxActivationsPerExt}) for '${idValue}'`,
                { extensionId: idValue });
        }
        rec.projects.add(projectId.value);
        return Object.freeze({ changed: true, id: idValue, project: projectId.value });
    }

    deactivateForProject(idOrRaw, projectOrRaw) {
        const [idValue] = this._record(idOrRaw);
        const projectId = createProjectId(projectOrRaw);
        const rec = this._records.get(idValue);
        const existed = rec.projects.delete(projectId.value);
        return Object.freeze({ changed: existed, id: idValue, project: projectId.value });
    }

    isActiveForProject(idOrRaw, projectOrRaw) {
        const id = asExtensionId(idOrRaw) ?? createExtensionId(idOrRaw);
        const projectId = asProjectId(projectOrRaw) ?? createProjectId(projectOrRaw);
        const rec = this._records.get(id.value);
        if (!rec) return false;
        return ACTIVE_STATES.has(rec.state) && rec.projects.has(projectId.value);
    }

    listActiveProjects(idOrRaw) {
        const [idValue, rec] = this._record(idOrRaw);
        return Object.freeze([...rec.projects].sort());
    }

    // -------------------------------------------------------------- queries

    getDescriptor(idOrRaw) {
        const [idValue, rec] = this._record(idOrRaw);
        void idValue;
        return this._frozenView(rec.descriptor);
    }

    getState(idOrRaw) {
        const [idValue] = this._record(idOrRaw);
        return this._records.get(idValue).state;
    }

    listDescriptors() {
        return Object.freeze(
            [...this._records.keys()].sort().map((k) => this._frozenView(this._records.get(k).descriptor)));
    }

    listStates() {
        const out = {};
        for (const k of [...this._records.keys()].sort()) out[k] = this._records.get(k).state;
        return deepFreeze(out);
    }

    getLastTransition(idOrRaw) {
        const [, rec] = this._record(idOrRaw);
        return this._frozenView(rec.lastTransition);
    }

    has(idOrRaw) {
        try {
            const id = asExtensionId(idOrRaw) ?? createExtensionId(idOrRaw);
            return this._records.has(id.value);
        } catch {
            return false;
        }
    }

    get size() { return this._records.size; }

    /** Capability advertisement query. Metadata ONLY — grants nothing. */
    getCapabilities(idOrRaw) {
        const [, rec] = this._record(idOrRaw);
        return this._frozenView(rec.descriptor.capabilities);
    }

    findExtensionsByCapability(capabilityRaw) {
        const cap = canonicalCapabilityName(capabilityRaw);
        const hits = [];
        for (const k of [...this._records.keys()].sort()) {
            if (this._records.get(k).descriptor.capabilities.includes(cap)) hits.push(k);
        }
        return Object.freeze(hits);
    }

    /** Declared authority requirements — descriptive read-model material. */
    getAuthorityRequirements(idOrRaw) {
        const [, rec] = this._record(idOrRaw);
        return this._frozenView(rec.descriptor.authorityRequirements);
    }

    getDependencyReport(idOrRaw) {
        const [idValue, rec] = this._record(idOrRaw);
        return buildDependencyReport(rec.descriptor, (depId) => {
            const other = this._records.get(depId);
            if (!other) return null;
            return {
                exists: true,
                state: other.state,
                version: other.descriptor.version
            };
        });
    }

    /** Registry-wide cycle audit (deterministic). */
    findAllDependencyCycles() {
        const map = new Map();
        for (const [k, rec] of this._records) map.set(k, rec.descriptor);
        return collectAllCycles(map);
    }

    // --------------------------------------------------------- configuration

    setConfigurationValues(idOrRaw, values) {
        const [idValue, rec] = this._record(idOrRaw);
        if (values === undefined || values === null) {
            rec.configurationValues = undefined;
            return Object.freeze({ changed: true, id: idValue });
        }
        let serialized;
        try {
            serialized = JSON.stringify(values);
        } catch {
            throw fail(REASONS.MALFORMED_INPUT, "configuration values must be JSON-representable");
        }
        if (serialized.length > MANIFEST_BOUNDS.MAX_CONFIG_BYTES) {
            throw fail(REASONS.BOUND_EXCEEDED, "configuration values exceed bound",
                { bytes: serialized.length });
        }
        rec.configurationValues = deepFreeze(assertNoDangerousKeys(JSON.parse(serialized)));
        return Object.freeze({ changed: true, id: idValue });
    }

    getConfigurationValues(idOrRaw) {
        const [, rec] = this._record(idOrRaw);
        return this._frozenView(rec.configurationValues);
    }

    // ----------------------------------------------------------- persistence

    /**
     * Deterministic serialization of canonical lifecycle/configuration
     * state. V1 keeps state in memory only; this snapshot exists for tests
     * and as the port shape a future store would persist. No live objects.
     */
    serializeState() {
        const extensions = [];
        for (const k of [...this._records.keys()].sort()) {
            const rec = this._records.get(k);
            extensions.push({
                id: k,
                state: rec.state,
                health: {
                    status: rec.healthStatus,
                    lastReportAtMs: rec.healthReport ? rec.healthReport.atMs : null,
                    diagnosticCount: rec.healthReport ? rec.healthReport.diagnostics.length : 0
                },
                projects: [...rec.projects].sort(),
                configurationValues: rec.configurationValues === undefined ? null : JSON.parse(JSON.stringify(rec.configurationValues))
            });
        }
        return deepFreeze({
            schemaVersion: 1,
            generatedAtMs: this._now(),
            extensions
        });
    }

    getStats() {
        const byState = {};
        for (const s of Object.values(STATES)) byState[s] = 0;
        for (const rec of this._records.values()) byState[rec.state] += 1;
        let activations = 0;
        for (const rec of this._records.values()) activations += rec.projects.size;
        return Object.freeze({
            extensions: this._records.size,
            maxExtensions: this._maxExtensions,
            byState: deepFreeze(byState),
            totalProjectActivations: activations
        });
    }
}

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

function assertNoDangerousKeys(node) {
    if (Array.isArray(node)) {
        for (const item of node) assertNoDangerousKeys(item);
        return node;
    }
    if (node === null || typeof node !== "object") return node;
    for (const key of Object.getOwnPropertyNames(node)) {
        if (DANGEROUS_KEYS.has(key)) {
            throw fail(REASONS.DANGEROUS_KEY, `dangerous key '${key}' in configuration values`);
        }
        assertNoDangerousKeys(node[key]);
    }
    return node;
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

module.exports = { ExtensionRegistry, DEFAULTS };
