"use strict";

/**
 * WAVE 6 L5 — Portable Core / Edge Runtime.
 *
 * A minimal Damar runtime for identity, continuity and bounded useful
 * operation away from the primary PC. EXTENDS frozen owners: mesh client
 * (L1), state checkpoints (L2), cognition substrate abstraction (Wave 5
 * federation — profile swap, never redesign).
 *
 * LAWS:
 *   EDGE PROFILE != AUTHORITY LEVEL   (degradation is availability, not power)
 *   USB PRESENCE != AUTHORITY
 *   OFFLINE != REVOKED ; offline core never invents approvals
 *   reconnect never silently overwrites canonical state (reconciliation only)
 */

const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const ids = require("../mesh/ids");

const EDGE_PROFILES = Object.freeze([
    "DESKTOP_PRIMARY", "DESKTOP_SECONDARY", "PORTABLE_CORE",
    "EDGE_LOW_POWER", "SERVER_PRIVATE", "REMOTE_COMPUTE", "TEMPORARY_NODE"
].reduce((m, p) => (p !== "" && (m[p] = p), m), {}));

const EDGE_LEVELS = Object.freeze(["EDGE_FULL", "EDGE_REDUCED", "EDGE_SURVIVAL", "EDGE_OFFLINE"].reduce((m, l) => (m[l] = l, m), {}));

const EDGE_DEFAULTS = Object.freeze({
    maxMemoryPointers: 32,
    maxAuditBuffer: 256,
    maxQueuedSync: 128,
    maxModelFallbacks: 4,
    lowMemoryThresholdPct: 0.85,
    diskLowThresholdPct: 0.9
});

/** Hardware/storage capacity declarations (bounded, descriptive). */
const RESOURCE_LIMITS = Object.freeze({
    maxRamMb: 65536,
    maxDiskMb: 2 * 1024 * 1024,
    maxStorageClasses: 8
});

/**
 * EdgeRuntimeProfile — resource/availability declaration. Carries NO
 * authority: profiles select function availability, never permissions.
 */
function buildEdgeRuntimeProfile({
    profile = "PORTABLE_CORE", ramMb = 2048, diskMb = 32768,
    hasGpu = false, batteryPowered = true, network = "INTERMITTENT",
    localModel = null, storageClasses = null
} = {}) {
    if (!EDGE_PROFILES[profile]) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `unknown edge profile '${String(profile).slice(0, 32)}'`);
    if (!Number.isFinite(ramMb) || ramMb <= 0 || ramMb > RESOURCE_LIMITS.maxRamMb) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `ramMb must be 1..${RESOURCE_LIMITS.maxRamMb}`);
    if (!Number.isFinite(diskMb) || diskMb <= 0 || diskMb > RESOURCE_LIMITS.maxDiskMb) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `diskMb must be 1..${RESOURCE_LIMITS.maxDiskMb}`);
    if (!["ALWAYS", "INTERMITTENT", "OFFLINE"].includes(network)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "network must be ALWAYS|INTERMITTENT|OFFLINE");
    const classes = (storageClasses ?? ["immutable-runtime", "config", "encrypted-identity", "encrypted-selective-state", "model-files", "audit-buffer", "cache"]).slice(0, RESOURCE_LIMITS.maxStorageClasses);
    return Object.freeze({
        profile,
        ramMb, diskMb, hasGpu: Boolean(hasGpu), batteryPowered: Boolean(batteryPowered),
        network, localModel: localModel ? String(localModel).slice(0, 256) : null,
        storageClasses: Object.freeze(classes),
        law: "PROFILE != AUTHORITY — resource/availability metadata only"
    });
}

/**
 * Derive the operating level from profile + resources. OFFLINE network or
 * exhausted memory degrade the level; NEVER the authority envelope.
 */
function deriveEdgeLevel(profileDef, { memoryUsedPct = 0, diskUsedPct = 0, networkReachable = null, nowMs = Date.now() } = {}) {
    if (profileDef.network === "OFFLINE" || networkReachable === false) return "EDGE_OFFLINE";
    if (memoryUsedPct >= EDGE_DEFAULTS.lowMemoryThresholdPct || diskUsedPct >= EDGE_DEFAULTS.diskLowThresholdPct) return "EDGE_SURVIVAL";
    if (profileDef.profile === "PORTABLE_CORE" || profileDef.profile === "EDGE_LOW_POWER") return "EDGE_REDUCED";
    return "EDGE_FULL";
}

/**
 * What the portable core may do at each level. SECURITY-INVARIANT: the
 * capability vocabulary per level never expands authority — it only
 * describes which ALREADY-AUTHORIZED local capabilities remain available.
 */
const LEVEL_CAPABILITIES = Object.freeze({
    EDGE_FULL: ["local-cognition", "permitted-memory", "authorized-local-tools", "audit", "state-sync", "mesh-client"],
    EDGE_REDUCED: ["local-cognition", "permitted-memory", "authorized-local-tools", "audit", "state-sync", "mesh-client"],
    EDGE_SURVIVAL: ["local-cognition", "permitted-memory", "audit"],
    EDGE_OFFLINE: ["local-cognition", "permitted-memory", "authorized-local-tools", "audit", "queued-sync"]
});

/**
 * PortableCoreRuntime — minimal runtime composition for the edge.
 * Composes frozen owners (mesh trust + registry, L2 checkpoints, audit
 * buffer); never a second Manager/Authority.
 */
class PortableCoreRuntime {
    constructor({ identity, profileDef, trust, registry, auditSink = null, nowMs = () => Date.now() } = {}) {
        this.identity = identity; // frozen NodeIdentity
        this.profileDef = profileDef;
        this.trust = trust;
        this.registry = registry;
        this.nowMs = nowMs;
        this.level = deriveEdgeLevel(profileDef, { networkReachable: profileDef.network !== "OFFLINE" });
        this.auditBuffer = []; // bounded
        this.auditSink = auditSink; // optional ledger port
        this.queuedSync = []; // bounded state updates waiting for reconnect
        this.modelFallbacks = [];
        this.resourceReports = 0;
    }

    /** Local audit with bounded buffer; flushes to sink when attached. */
    audit(event) {
        const record = Object.freeze({ at: new Date(this.nowMs()).toISOString(), node: this.identity.nodeId, event: String(event).slice(0, 300) });
        if (this.auditSink) {
            try { this.auditSink.append(record); return { buffered: false }; } catch { /* sink offline -> buffer */ }
        }
        if (this.auditBuffer.length >= EDGE_DEFAULTS.maxAuditBuffer) this.auditBuffer.shift();
        this.auditBuffer.push(record);
        return { buffered: true };
    }

    flushAudit() {
        if (!this.auditSink) return { flushed: 0 };
        let flushed = 0;
        while (this.auditBuffer.length > 0) {
            try { this.auditSink.append(this.auditBuffer[0]); this.auditBuffer.shift(); flushed++; }
            catch { break; }
        }
        return { flushed };
    }

    /** Queue a state update produced offline (reconciled on reconnect — L2 policies). */
    queueSync(envelope) {
        if (this.queuedSync.length >= EDGE_DEFAULTS.maxQueuedSync) this.queuedSync.shift();
        this.queuedSync.push(Object.freeze({ envelope, queuedAtMs: this.nowMs() }));
        return { queued: this.queuedSync.length };
    }

    drainQueuedSync() {
        const out = this.queuedSync.splice(0, this.queuedSync.length);
        return Object.freeze(out.map(x => Object.freeze({ ...x })));
    }

    /**
     * Reconnect: drain queued sync + restore level. The RECONNECTING core
     * never pushes authority and never overwrites canonical state — the L2
     * reconciliation policies decide (caller applies via DistributedStateStore).
     */
    reconnect({ networkReachable = true, memoryUsedPct = 0.3, diskUsedPct = 0.2 } = {}) {
        this.profileDef = Object.freeze({ ...this.profileDef, network: networkReachable ? this.profileDef.network : "OFFLINE" });
        this.level = deriveEdgeLevel(this.profileDef, { memoryUsedPct, diskUsedPct, networkReachable });
        const drained = this.drainQueuedSync();
        this.audit("reconnect: level=" + this.level + " queuedSync=" + drained.length);
        return Object.freeze({ level: this.level, queuedSyncDrained: drained.length });
    }

    /**
     * Local model unavailability: fall back within the SAME cognitive
     * substrate abstraction (profile/model swap, not redesign). Bounded
     * fallback list; future Wises introduction is exactly such a swap.
     */
    reportLocalModelMissing({ fallbackModelId = null } = {}) {
        if (this.modelFallbacks.length >= EDGE_DEFAULTS.maxModelFallbacks) {
            throw meshFailure(MESH_ERRORS.EDGE_RESOURCE_EXHAUSTED, "model fallback budget exhausted");
        }
        this.modelFallbacks.push({ atMs: this.nowMs(), fallbackModelId: fallbackModelId ? String(fallbackModelId).slice(0, 128) : null });
        this.audit("local model missing; fallback=" + String(fallbackModelId ?? "none").slice(0, 64));
        return Object.freeze({ fallbacksUsed: this.modelFallbacks.length, cognitionStillLocal: true });
    }

    /** Resource report (disk low / memory pressure) — degradation only. */
    reportResources({ memoryUsedPct = 0, diskUsedPct = 0 } = {}) {
        this.resourceReports++;
        this.level = deriveEdgeLevel(this.profileDef, { memoryUsedPct, diskUsedPct, networkReachable: this.profileDef.network !== "OFFLINE" });
        if (this.level === "EDGE_SURVIVAL") this.audit("resource degradation -> EDGE_SURVIVAL");
        return Object.freeze({ level: this.level });
    }

    stats() {
        return Object.freeze({
            nodeId: this.identity.nodeId,
            profile: this.profileDef.profile,
            level: this.level,
            auditBuffered: this.auditBuffer.length,
            queuedSync: this.queuedSync.length,
            modelFallbacks: this.modelFallbacks.length,
            resourceReports: this.resourceReports
        });
    }
}

module.exports = Object.freeze({
    EDGE_PROFILES, EDGE_LEVELS, LEVEL_CAPABILITIES, EDGE_DEFAULTS, RESOURCE_LIMITS,
    buildEdgeRuntimeProfile, deriveEdgeLevel, PortableCoreRuntime
});
