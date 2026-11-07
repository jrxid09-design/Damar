"use strict";

/**
 * WAVE 6 MESH — NodeRegistry (L1).
 *
 * Canonical node membership registry. LAWS:
 *   NODE MEMBERSHIP != AUTHORITY
 *   NODE DISCOVERY != NODE TRUST
 *   MESH PRESENCE != IDENTITY PROOF
 *
 * IMMUTABLE per node: nodeId, logicalDamarId, identityProvenance, recordId.
 * MUTABLE bounded metadata: displayName, transport addresses, liveness,
 * capability/resource summaries, lastSeen, trustRecord reference.
 *
 * An arbitrary update patch can NEVER mutate identity fields — identity
 * updates go through explicit replaceNodeIdentity which is rejected while
 * any binding exists (identity is terminal).
 *
 * BOUNDED: maxNodes registry cap, maxAddresses per node, summary entry caps.
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");
const { coerceNodeIdentity } = require("./meshIdentity");

const DEFAULTS = Object.freeze({
    maxNodes: 256,
    maxAddresses: 8,
    maxSummaryEntries: 64,
    maxSummaryValueChars: 128,
    maxDisplayNameChars: 120
});

const DANGEROUS_KEYS = Object.freeze(new Set(["__proto__", "constructor", "prototype"]));

const LIVENESS_STATES = Object.freeze([
    "UNKNOWN", "ONLINE", "DEGRADED", "OFFLINE", "SUSPECT", "RECOVERING"
].reduce((m, s) => (m[s] = s, m), {}));

class NodeRegistry {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** nodeId -> record (mutable metadata object; identity fields frozen) */
        this._nodes = new Map();
    }

    /**
     * Register a node identity. Re-registration with the SAME nodeId must
     * carry the identical logicalDamarId + identityDigest (ABA-safe); a
     * conflicting identity is rejected as forged.
     */
    register({ identity, displayName = null, initialTrust = null } = {}) {
        const id = coerceNodeIdentity(identity);
        if (this._nodes.size >= this.config.maxNodes) {
            throw meshFailure(MESH_ERRORS.NODE_REGISTRY_FULL, `registry at cap ${this.config.maxNodes}`);
        }
        const existing = this._nodes.get(id.nodeId);
        if (existing) {
            if (existing.identity.logicalDamarId !== id.logicalDamarId || existing.identity.identityDigest !== id.identityDigest) {
                throw meshFailure(MESH_ERRORS.NODE_IDENTITY_MALFORMED, "nodeId re-registration with conflicting identity (forged)");
            }
            return this.snapshotNode(id.nodeId); // idempotent
        }
        const recordId = ids.mint.registryRecordId();
        this._nodes.set(id.nodeId, {
            recordId,
            identity: id, // frozen
            displayName: boundName(displayName, this.config.maxDisplayNameChars),
            addresses: [], // bounded transport addresses (attributes, NOT identity)
            liveness: LIVENESS_STATES.UNKNOWN,
            lastSeenMs: this.nowMs(),
            registeredAtMs: this.nowMs(),
            trustRef: initialTrust, // { trustGeneration, state } reference only
            capabilitySummary: {},
            resourceSummary: {}
        });
        return this.snapshotNode(id.nodeId);
    }

    lookup(nodeId) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._nodes.get(checked);
        return rec ? this.snapshotNode(checked) : null;
    }

    require(nodeId) {
        const snap = this.lookup(nodeId);
        if (!snap) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, `node ${String(nodeId).slice(0, 24)} not registered`);
        return snap;
    }

    /**
     * Mutable metadata update. Identity fields are structurally impossible
     * to change here: the patch vocabulary is closed and identity keys are
     * rejected before any mutation.
     */
    update(nodeId, patch = {}) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._nodes.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, "node not registered");
        const IDENTITY_KEYS = new Set(["nodeId", "logicalDamarId", "identityProvenance", "identityDigest", "recordId", "identity", "registeredAtMs"]);
        for (const k of Object.keys(patch)) {
            if (IDENTITY_KEYS.has(k)) {
                throw meshFailure(MESH_ERRORS.IDENTITY_IMMUTABLE, `field '${k}' is immutable`);
            }
            if (DANGEROUS_KEYS.has(k)) throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, "dangerous patch key");
        }
        if (patch.displayName !== undefined) rec.displayName = boundName(patch.displayName, this.config.maxDisplayNameChars);
        if (patch.addresses !== undefined) rec.addresses = boundAddresses(patch.addresses, this.config.maxAddresses);
        if (patch.liveness !== undefined) {
            if (!LIVENESS_STATES[patch.liveness]) throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, `unknown liveness '${String(patch.liveness).slice(0, 24)}'`);
            rec.liveness = patch.liveness;
        }
        if (patch.capabilitySummary !== undefined) rec.capabilitySummary = boundSummary(patch.capabilitySummary, this.config);
        if (patch.resourceSummary !== undefined) rec.resourceSummary = boundSummary(patch.resourceSummary, this.config);
        if (patch.trustRef !== undefined) rec.trustRef = patch.trustRef && typeof patch.trustRef === "object" ? Object.freeze({ trustGeneration: ids.check.trustGeneration(patch.trustRef.trustGeneration), state: String(patch.trustRef.state).slice(0, 24) }) : null;
        rec.lastSeenMs = this.nowMs();
        return this.snapshotNode(checked);
    }

    /** Presence observation is telemetry ONLY — never mutates trust. */
    observeLiveness(nodeId, state) {
        return this.update(nodeId, { liveness: state });
    }

    list() {
        return Object.freeze([...this._nodes.keys()].sort().map(k => this.snapshotNode(k)));
    }

    size() { return this._nodes.size; }

    snapshotNode(nodeId) {
        const rec = this._nodes.get(nodeId);
        return Object.freeze({
            recordId: rec.recordId,
            identity: rec.identity, // already frozen
            displayName: rec.displayName,
            addresses: Object.freeze([...rec.addresses]),
            liveness: rec.liveness,
            lastSeenMs: rec.lastSeenMs,
            registeredAtMs: rec.registeredAtMs,
            trustRef: rec.trustRef ? Object.freeze({ ...rec.trustRef }) : null,
            capabilitySummary: Object.freeze({ ...rec.capabilitySummary }),
            resourceSummary: Object.freeze({ ...rec.resourceSummary })
        });
    }
}

function boundName(name, max) {
    if (name === null || name === undefined) return null;
    const s = String(name);
    if (s.length > max) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "displayName too long");
    return s;
}

function boundAddresses(addresses, max) {
    if (!Array.isArray(addresses)) throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, "addresses must be an array");
    if (addresses.length > max) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `addresses exceed ${max}`);
    const out = [];
    for (const a of addresses.slice(0, max)) {
        if (typeof a !== "string" || a.length === 0 || a.length > 256) {
            throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, "address must be a string <= 256 chars");
        }
        out.push(a);
    }
    return Object.freeze(out);
}

function boundSummary(summary, config) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
        throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, "summary must be an object");
    }
    const keys = Object.keys(summary);
    if (keys.length > config.maxSummaryEntries) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `summary exceeds ${config.maxSummaryEntries} entries`);
    const out = {};
    for (const k of keys) {
        if (DANGEROUS_KEYS.has(k)) throw meshFailure(MESH_ERRORS.REGISTRY_UPDATE_REJECTED, "dangerous summary key");
        const v = summary[k];
        const sv = typeof v === "number" ? (Number.isFinite(v) ? v : 0) : String(v ?? "").slice(0, config.maxSummaryValueChars);
        out[String(k).slice(0, 64)] = sv;
    }
    return out;
}

module.exports = Object.freeze({ NodeRegistry, LIVENESS_STATES, DEFAULTS });
