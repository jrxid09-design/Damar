"use strict";

/**
 * WAVE 6 MESH — bounded replay guard (L1).
 *
 * Replay defense: opaque messageId + expiry + trustGeneration + a bounded
 * recent-message ledger (LRU). NO unbounded permanent replay set.
 * Expired trust generations invalidate old messages at the trust layer;
 * this guard covers wire-level duplicate/replay within the retention window.
 */

const ids = require("./ids");
const { meshFailure, MESH_ERRORS } = require("./errors");

const DEFAULTS = Object.freeze({
    maxEntries: 8192,           // hard LRU cap
    retentionMs: 10 * 60 * 1000 // entries older than this are swept
});

class MeshReplayGuard {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** key -> expiryMs, Map preserves insertion order (LRU semantics) */
        this._seen = new Map();
    }

    static keyFor(envelope) {
        return `${ids.check.nodeId(envelope.sourceNodeId)}|${ids.check.meshMessageId(envelope.messageId)}`;
    }

    /**
     * Accept-and-record. Throws MESH_REPLAY when the exact
     * (sourceNodeId, messageId) pair was already accepted within retention.
     */
    accept(envelope) {
        const key = MeshReplayGuard.keyFor(envelope);
        const now = this.nowMs();
        this._sweep(now);
        if (this._seen.has(key)) {
            throw meshFailure(MESH_ERRORS.MESH_REPLAY, `duplicate message '${String(envelope.messageId).slice(0, 24)}' from '${String(envelope.sourceNodeId).slice(0, 24)}'`);
        }
        while (this._seen.size >= this.config.maxEntries) {
            const oldest = this._seen.keys().next().value;
            this._seen.delete(oldest);
        }
        this._seen.set(key, Math.min(envelope.expiryMs, now + this.config.retentionMs));
        return Object.freeze({ accepted: true, key });
    }

    /** Explicit check without recording (tests/diagnostics). */
    seen(envelope) {
        return this._seen.has(MeshReplayGuard.keyFor(envelope));
    }

    _sweep(now) {
        for (const [key, expiry] of this._seen) {
            if (expiry <= now) this._seen.delete(key);
            else break; // insertion-ordered by expiry bucket boundary; full sweep below if needed
        }
        if (this._seen.size > 0) {
            for (const [key, expiry] of this._seen) {
                if (expiry <= now) this._seen.delete(key);
            }
        }
    }

    size() { return this._seen.size; }
}

module.exports = Object.freeze({ MeshReplayGuard, DEFAULTS });
