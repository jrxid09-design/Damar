"use strict";

/**
 * WAVE 6 L6 — bounded circuit breakers for nodes/providers/tools/models/transports.
 *
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED|OPEN.
 * Circuit status is RELIABILITY METADATA — never trust, never authority.
 * Circles feed the router as score input only.
 */

const { meshFailure, MESH_ERRORS } = require("../mesh/errors");

const CIRCUIT_STATES = Object.freeze(["CLOSED", "OPEN", "HALF_OPEN"].reduce((m, s) => (m[s] = s, m), {}));

const DEFAULTS = Object.freeze({
    failureThreshold: 5,        // failures before OPEN
    openMs: 30_000,             // OPEN duration before HALF_OPEN probe
    maxTracked: 256,            // bounded circuit table
    halfOpenMaxProbes: 1
});

class CircuitBreakers {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** key (e.g. "node:dnode-..", "provider:openai") -> circuit */
        this._circuits = new Map();
    }

    _circuit(key) {
        const k = String(key).slice(0, 160);
        let c = this._circuits.get(k);
        if (!c) {
            if (this._circuits.size >= this.config.maxTracked) {
                // reclaim oldest CLOSED circuit
                for (const [ck, cv] of this._circuits) {
                    if (cv.state === "CLOSED") { this._circuits.delete(ck); break; }
                }
                if (this._circuits.size >= this.config.maxTracked) {
                    throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "circuit table full");
                }
            }
            c = { state: "CLOSED", failures: 0, successes: 0, openedAtMs: 0, halfOpenProbes: 0 };
            this._circuits.set(k, c);
        }
        return c;
    }

    /** Record a failure; may OPEN the circuit. */
    failure(key) {
        const c = this._circuit(key);
        c.failures++;
        if (c.state === "CLOSED" && c.failures >= this.config.failureThreshold) {
            c.state = "OPEN";
            c.openedAtMs = this.nowMs();
            c.halfOpenProbes = 0;
        } else if (c.state === "HALF_OPEN") {
            c.state = "OPEN";
            c.openedAtMs = this.nowMs();
            c.halfOpenProbes = 0;
        }
        return this.status(key);
    }

    /** Record a success; closes HALF_OPEN/CLOSED circuits and resets counts. */
    success(key) {
        const c = this._circuit(key);
        c.successes++;
        if (c.state === "HALF_OPEN" || c.state === "CLOSED") {
            c.state = "CLOSED";
            c.failures = 0;
            c.halfOpenProbes = 0;
        }
        return this.status(key);
    }

    /**
     * Availability probe: is the circuit allowing attempts right now?
     * OPEN -> HALF_OPEN after openMs (probe allowed). Metadata only.
     */
    allow(key) {
        const c = this._circuit(key);
        if (c.state === "CLOSED") return true;
        if (c.state === "OPEN" && this.nowMs() - c.openedAtMs >= this.config.openMs) {
            c.state = "HALF_OPEN";
            c.halfOpenProbes = 0;
        }
        if (c.state === "HALF_OPEN") {
            if (c.halfOpenProbes < this.config.halfOpenMaxProbes) {
                c.halfOpenProbes++;
                return true;
            }
            return false;
        }
        return false;
    }

    status(key) {
        const c = this._circuit(key);
        return Object.freeze({ key: String(key).slice(0, 160), state: c.state, failures: c.failures, successes: c.successes });
    }

    size() { return this._circuits.size; }
}

module.exports = Object.freeze({ CircuitBreakers, CIRCUIT_STATES, DEFAULTS });
