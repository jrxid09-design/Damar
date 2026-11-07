"use strict";

/**
 * WAVE 6 MESH — presence / liveness (L1).
 *
 * MESH PRESENCE != IDENTITY PROOF
 * ONLINE != TRUSTED ; OFFLINE != REVOKED
 *
 * Liveness is TELEMETRY. This module tracks observed presence windows and
 * derives state; it can never mutate trust or identity.
 */

const { LIVENESS_STATES } = require("./nodeRegistry");
const ids = require("./ids");

const DEFAULTS = Object.freeze({
    onlineWindowMs: 15_000,     // fresh observation window
    suspectAfterMs: 30_000,     // no observation -> SUSPECT
    offlineAfterMs: 120_000,    // no observation -> OFFLINE
    maxTracked: 256
});

class MeshPresence {
    constructor({ registry = null, config = {}, nowMs = () => Date.now() } = {}) {
        this.registry = registry;
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** nodeId -> { lastObservedMs, lastState } */
        this._observed = new Map();
    }

    /** Record an observation (from envelope ingress or local probe). */
    observe(nodeId, state = "ONLINE") {
        const checked = ids.check.nodeId(nodeId);
        if (!LIVENESS_STATES[state]) throw new TypeError(`unknown liveness state '${String(state).slice(0, 24)}'`);
        if (this._observed.size >= this.config.maxTracked && !this._observed.has(checked)) {
            const oldest = [...this._observed.entries()].sort((a, b) => a[1].lastObservedMs - b[1].lastObservedMs)[0];
            if (oldest) this._observed.delete(oldest[0]);
        }
        this._observed.set(checked, { lastObservedMs: this.nowMs(), lastState: state });
        if (this.registry) { try { this.registry.observeLiveness(checked, state); } catch { /* telemetry only */ } }
        return this.state(nodeId);
    }

    /** Derived presence state from observation windows. */
    state(nodeId) {
        const checked = ids.check.nodeId(nodeId);
        const rec = this._observed.get(checked);
        if (!rec) return "UNKNOWN";
        const age = this.nowMs() - rec.lastObservedMs;
        if (age <= this.config.onlineWindowMs) return rec.lastState === "OFFLINE" ? "OFFLINE" : rec.lastState;
        if (age <= this.config.suspectAfterMs) return rec.lastState === "OFFLINE" ? "OFFLINE" : "SUSPECT";
        if (age <= this.config.offlineAfterMs) return rec.lastState === "OFFLINE" ? "OFFLINE" : "RECOVERING";
        return "OFFLINE";
    }

    /** Explicit offline marking (graceful shutdown notice). */
    markOffline(nodeId) {
        return this.observe(nodeId, "OFFLINE");
    }

    lastObservedMs(nodeId) {
        const rec = this._observed.get(ids.check.nodeId(nodeId));
        return rec ? rec.lastObservedMs : null;
    }

    size() { return this._observed.size; }
}

module.exports = Object.freeze({ MeshPresence, DEFAULTS });
