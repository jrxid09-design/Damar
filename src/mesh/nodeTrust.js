"use strict";

/**
 * WAVE 6 MESH — scoped NodeTrust (L1).
 *
 * LAWS:
 *   NODE TRUST != GLOBAL AUTHORITY
 *   NODE MEMBERSHIP != AUTHORITY
 *   PAIRING != PERMANENT TRUST
 *   NODE DISCOVERY != NODE TRUST
 *   TRUST IS A SCOPED, REVOCABLE, EXPIRING RELATIONSHIP — never a boolean.
 *
 * Trust is a per-node vector of scoped grants. Each grant carries an opaque
 * trustGeneration (`ntgen-<32hex>`): revocation/reset mints a FRESH
 * generation, and every old generation fails stale by exact identity
 * comparison (no numeric epochs — the certified pdlep_/wrtep_ discipline).
 *
 * Scopes are capability-boundary metadata ONLY. Nothing here grants
 * authority; privileged operations still flow through the canonical
 * Authority/Manager plane.
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");
const { sha256Hex } = require("./canonical");

const TRUST_STATES = Object.freeze([
    "DISCOVERED", "UNPAIRED", "PAIRING_PENDING", "TRUSTED", "LIMITED", "QUARANTINED", "REVOKED", "EXPIRED"
].reduce((m, s) => (m[s] = s, m), {}));

/** Terminal states accept no further transitions except explicit re-pair (new generation). */
const TERMINAL_STATES = Object.freeze(new Set(["REVOKED", "EXPIRED"]));

const TRUST_SCOPES = Object.freeze([
    "OBSERVE",
    "STATE_REPLICA",
    "MEMORY_REPLICA",
    "COMPUTE",
    "TOOL_EXECUTION",
    "PORTABLE_CORE",
    "RECOVERY_PEER",
    "ADMINISTRATIVE_HOST"
].reduce((m, s) => (m[s] = s, m), {}));

const DEFAULTS = Object.freeze({
    maxTrustedNodes: 256,
    maxScopeHistoryPerNode: 8,
    defaultTrustTtlMs: 30 * 24 * 3600 * 1000 // 30 days; pairing != permanent trust
});

function validScope(s) { return Boolean(TRUST_SCOPES[s]); }

class NodeTrust {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** nodeId -> { state, generation, scopes:Map(scope->{grantedAtMs,expiresAtMs}), history:[] } */
        this._trust = new Map();
        /** nodeId -> prior generations ever rotated out (bounded per node) */
        this._retiredGenerations = new Map();
    }

    /**
     * Bootstrap/pair a node into a trust state with scoped grants.
     * Mints a FRESH trust generation. Pairing approval is expected to have
     * happened in the frozen DeviceIdentity owner; this records the
     * relationship metadata ONLY.
     */
    pair({ nodeId, state = "TRUSTED", scopes = [], ttlMs = null, evidence = null } = {}) {
        const checked = ids.check.nodeId(nodeId);
        if (!TRUST_STATES[state]) throw meshFailure(MESH_ERRORS.PAIRING_INVALID, `unknown trust state '${String(state).slice(0, 24)}'`);
        if (TERMINAL_STATES.has(state)) throw meshFailure(MESH_ERRORS.PAIRING_INVALID, "pair() cannot mint a terminal state");
        if (this._trust.size >= this.config.maxTrustedNodes && !this._trust.has(checked)) {
            throw meshFailure(MESH_ERRORS.NODE_REGISTRY_FULL, `trust table at cap ${this.config.maxTrustedNodes}`);
        }
        const scopeList = normalizeScopes(scopes);
        const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : this.config.defaultTrustTtlMs;
        const generation = ids.mint.trustGeneration();
        const now = this.nowMs();
        const grants = new Map();
        for (const s of scopeList) grants.set(s, Object.freeze({ grantedAtMs: now, expiresAtMs: now + ttl }));
        const prior = this._trust.get(checked);
        if (prior) {
            const retired = this._retiredGenerations.get(checked) ?? [];
            retired.push(prior.generation);
            this._retiredGenerations.set(checked, retired.slice(-this.config.maxScopeHistoryPerNode));
        }
        const record = {
            nodeId: checked,
            state,
            generation,
            scopes: grants,
            pairedAtMs: now,
            evidence: evidence ? String(evidence).slice(0, 300) : null,
            trustDigest: sha256Hex({ nodeId: checked, generation, state, scopes: scopeList.sort() })
        };
        this._trust.set(checked, record);
        return this.snapshot(checked);
    }

    /** Current trust snapshot; null when the node is unknown to the trust plane. */
    snapshot(nodeId) {
        const rec = this._trust.get(ids.check.nodeId(nodeId));
        if (!rec) return null;
        const now = this.nowMs();
        const scopes = {};
        let anyValid = false;
        for (const [scope, g] of rec.scopes) {
            const expired = g.expiresAtMs <= now;
            scopes[scope] = Object.freeze({ ...g, expired });
            if (!expired) anyValid = true;
        }
        let state = rec.state;
        if (state !== "REVOKED" && state !== "QUARANTINED" && !anyValid && rec.scopes.size > 0) {
            state = "EXPIRED"; // all scopes expired -> EXPIRED (fail-closed)
        }
        return Object.freeze({
            nodeId: rec.nodeId,
            state,
            trustGeneration: rec.generation,
            scopes: Object.freeze(scopes),
            pairedAtMs: rec.pairedAtMs,
            evidence: rec.evidence,
            trustDigest: rec.trustDigest
        });
    }

    /**
     * THE central check. Exact-scope, exact-generation, fail-closed.
     * A caller must present the trustGeneration it believes is current;
     * stale generations are rejected even if the scope would otherwise pass.
     */
    authorize({ nodeId, scope, trustGeneration, atMs = null } = {}) {
        const checked = ids.check.nodeId(nodeId);
        if (!validScope(scope)) throw meshFailure(MESH_ERRORS.TRUST_SCOPE_MISSING, `unknown scope '${String(scope).slice(0, 32)}'`);
        const rec = this._trust.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "node has no trust relationship");
        const gen = ids.check.trustGeneration(trustGeneration);
        if (gen !== rec.generation) {
            throw meshFailure(MESH_ERRORS.TRUST_GENERATION_STALE, "presented trust generation is not current");
        }
        if (rec.state === "REVOKED") throw meshFailure(MESH_ERRORS.NODE_REVOKED, "node trust revoked");
        if (rec.state === "QUARANTINED") throw meshFailure(MESH_ERRORS.NODE_QUARANTINED, "node quarantined");
        if (rec.state === "EXPIRED") throw meshFailure(MESH_ERRORS.TRUST_EXPIRED, "trust expired");
        if (rec.state !== "TRUSTED" && rec.state !== "LIMITED") {
            throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, `trust state '${rec.state}' grants no scopes`);
        }
        const grant = rec.scopes.get(scope);
        if (!grant) throw meshFailure(MESH_ERRORS.TRUST_SCOPE_MISSING, `scope '${scope}' not granted`);
        const now = atMs ?? this.nowMs();
        if (grant.expiresAtMs <= now) throw meshFailure(MESH_ERRORS.TRUST_EXPIRED, `scope '${scope}' expired`);
        return Object.freeze({ nodeId: checked, scope, trustGeneration: gen, expiresAtMs: grant.expiresAtMs });
    }

    /** Grant an additional scope under the CURRENT generation (no rotation). */
    grantScope({ nodeId, scope, ttlMs = null } = {}) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._trust.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "node has no trust relationship");
        if (!validScope(scope)) throw meshFailure(MESH_ERRORS.TRUST_SCOPE_MISSING, `unknown scope '${String(scope).slice(0, 32)}'`);
        if (rec.state === "REVOKED" || rec.state === "EXPIRED") throw meshFailure(MESH_ERRORS.NODE_REVOKED, "cannot grant scope in terminal state");
        const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : this.config.defaultTrustTtlMs;
        rec.scopes.set(scope, Object.freeze({ grantedAtMs: this.nowMs(), expiresAtMs: this.nowMs() + ttl }));
        return this.snapshot(checked);
    }

    /** Revoke a scope: immediate fail-closed for that scope. */
    revokeScope({ nodeId, scope } = {}) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._trust.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "node has no trust relationship");
        rec.scopes.delete(scope);
        return this.snapshot(checked);
    }

    /** Quarantine: scopes retained but unusable until released. */
    quarantine(nodeId, { reason = "quarantined" } = {}) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._trust.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, "node unknown to trust plane");
        rec.state = "QUARANTINED";
        rec.evidence = String(reason).slice(0, 300);
        return this.snapshot(checked);
    }

    releaseQuarantine(nodeId) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._trust.get(checked);
        if (!rec || rec.state !== "QUARANTINED") throw meshFailure(MESH_ERRORS.NODE_UNTRUSTED, "node not quarantined");
        rec.state = "LIMITED";
        return this.snapshot(checked);
    }

    /**
     * REVOCATION (L1 §19): immediate, terminal for the current generation.
     * The generation is rotated so old mesh credentials/messages fail stale.
     * A future re-pair goes through pair() and mints a NEW generation —
     * an old proof never resurrects trust (old generation != current).
     */
    revoke(nodeId, { reason = "revoked" } = {}) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._trust.get(checked);
        if (!rec) throw meshFailure(MESH_ERRORS.NODE_UNKNOWN, "node unknown to trust plane");
        rec.state = "REVOKED";
        rec.evidence = String(reason).slice(0, 300);
        rec.scopes = new Map(); // immediate scope invalidation
        const retired = this._retiredGenerations.get(checked) ?? [];
        retired.push(rec.generation);
        this._retiredGenerations.set(checked, retired.slice(-this.config.maxScopeHistoryPerNode));
        rec.generation = ids.mint.trustGeneration(); // rotate: old generation is stale forever
        return this.snapshot(checked);
    }

    /** True when the presented generation is retired/unknown (stale). */
    isStaleGeneration(nodeId, trustGeneration) {
        const checked = ids.check.nodeId(nodeId);
        const gen = ids.check.trustGeneration(trustGeneration);
        const rec = this._trust.get(checked);
        if (!rec) return true;
        if (gen !== rec.generation) {
            const retired = this._retiredGenerations.get(checked) ?? [];
            return retired.includes(gen) || true; // any non-current generation is stale
        }
        return false;
    }

    retiredGenerations(nodeId) {
        return Object.freeze([...(this._retiredGenerations.get(ids.check.nodeId(nodeId)) ?? [])]);
    }

    list() {
        return Object.freeze([...this._trust.keys()].sort().map(k => this.snapshot(k)));
    }

    size() { return this._trust.size; }
}

function normalizeScopes(scopes) {
    if (!Array.isArray(scopes)) throw meshFailure(MESH_ERRORS.PAIRING_INVALID, "scopes must be an array");
    const out = [...new Set(scopes)];
    if (out.length > TRUST_SCOPES_LIST.length) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "too many scopes");
    for (const s of out) {
        if (!validScope(s)) throw meshFailure(MESH_ERRORS.PAIRING_INVALID, `unknown scope '${String(s).slice(0, 32)}'`);
    }
    return out;
}

const TRUST_SCOPES_LIST = Object.freeze(Object.keys(TRUST_SCOPES));

module.exports = Object.freeze({ NodeTrust, TRUST_STATES, TRUST_SCOPES, TRUST_SCOPES_LIST, TERMINAL_STATES, DEFAULTS });
