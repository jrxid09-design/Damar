"use strict";

/**
 * RUNTIME HOST PHASES — fase PROSES Runtime Host, bukan status entitas.
 *
 * HUKUM (load-bearing):
 *   - Status entitas (DORMANT/AWAKE/ACTIVE/...) adalah milik KANONIK
 *     Presence Runtime. Modul ini TIDAK menduplikasi status tersebut.
 *   - Fase host hanya menjawab: "proses host sedang berada di tahap
 *     lifecycle proses yang mana". Summon != Permission, Dismiss !=
 *     Shutdown: DISMISS tetap fase READY; SHUTDOWN adalah satu-satunya
 *     jalan menuju TERMINATED.
 */

const HOST_PHASE = Object.freeze({
    NEW: "NEW",
    BOOTING: "BOOTING",
    INITIALIZING: "INITIALIZING",
    RECOVERING: "RECOVERING",
    READY: "READY",
    FAILED: "FAILED",
    SHUTTING_DOWN: "SHUTTING_DOWN",
    TERMINATED: "TERMINATED"
});

/** Graf legal fase proses. Di luar graf ini gagal tertutup. */
const HOST_PHASE_EDGES = buildEdges();

function buildEdges() {
    const edges = new Map();
    function add(from, to) {
        const key = `${from}>${to}`;
        if (!edges.has(key)) edges.set(key, []);
        edges.get(key).push(to);
    }

    add(HOST_PHASE.NEW, HOST_PHASE.BOOTING);
    add(HOST_PHASE.NEW, HOST_PHASE.TERMINATED);
    add(HOST_PHASE.BOOTING, HOST_PHASE.INITIALIZING);
    add(HOST_PHASE.BOOTING, HOST_PHASE.FAILED);
    add(HOST_PHASE.BOOTING, HOST_PHASE.SHUTTING_DOWN);
    add(HOST_PHASE.INITIALIZING, HOST_PHASE.RECOVERING);
    add(HOST_PHASE.INITIALIZING, HOST_PHASE.FAILED);
    add(HOST_PHASE.INITIALIZING, HOST_PHASE.SHUTTING_DOWN);
    add(HOST_PHASE.RECOVERING, HOST_PHASE.READY);
    add(HOST_PHASE.RECOVERING, HOST_PHASE.FAILED);
    add(HOST_PHASE.RECOVERING, HOST_PHASE.SHUTTING_DOWN);
    add(HOST_PHASE.READY, HOST_PHASE.RECOVERING);
    add(HOST_PHASE.READY, HOST_PHASE.FAILED);
    add(HOST_PHASE.READY, HOST_PHASE.SHUTTING_DOWN);
    add(HOST_PHASE.FAILED, HOST_PHASE.RECOVERING);
    add(HOST_PHASE.FAILED, HOST_PHASE.SHUTTING_DOWN);
    add(HOST_PHASE.SHUTTING_DOWN, HOST_PHASE.TERMINATED);
    for (const [key, value] of edges) edges.set(key, Object.freeze(value));
    return Object.freeze(edges);
}

function canTransitionPhase(from, to) {
    const allowed = HOST_PHASE_EDGES.get(`${from}>${to}`);
    return Array.isArray(allowed);
}

class HostPhaseMachine {
    constructor({ onChange = null } = {}) {
        this._phase = HOST_PHASE.NEW;
        this._onChange = onChange;
        this._history = [];
    }

    get phase() { return this._phase; }

    transitionTo(next, detail = null) {
        if (!canTransitionPhase(this._phase, next)) {
            return {
                ok: false,
                code: "HOST_PHASE_ILLEGAL",
                from: this._phase,
                to: next
            };
        }
        const previous = this._phase;
        this._phase = next;
        this._history.push({ from: previous, to: next, at: Date.now(), detail: detail === null ? null : String(detail).slice(0, 200) });
        if (this._history.length > 256) this._history.shift();
        if (this._onChange) {
            try { this._onChange({ from: previous, to: next }); } catch { /* listener fault tidak mengubah fase */ }
        }
        return { ok: true, from: previous, to: next };
    }

    isOperational() {
        return this._phase === HOST_PHASE.READY;
    }

    isTerminal() {
        return this._phase === HOST_PHASE.TERMINATED;
    }

    snapshot() {
        return Object.freeze({
            phase: this._phase,
            history: Object.freeze(this._history.map((h) => Object.freeze({ ...h })))
        });
    }
}

module.exports = Object.freeze({
    HOST_PHASE,
    HOST_PHASE_EDGES,
    canTransitionPhase,
    HostPhaseMachine
});
