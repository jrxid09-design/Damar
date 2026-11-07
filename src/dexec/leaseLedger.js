"use strict";

/**
 * WAVE 6 R1 (W6-03 REPAIR) — mandatory target-side lease consumption owner.
 *
 * BLOCKER REPAIRED: replay protection previously depended on an OPTIONAL
 * caller-supplied `consumedNonces` set — a fresh Set per verifier call
 * silently created a new replay universe. CALLER-PROVIDED LEDGER != REPLAY
 * PROTECTION.
 *
 * This ledger is THE single mandatory consumption owner for a node:
 *   - VERIFY + CONSUME happen as ONE synchronous security operation
 *     (atomic under JS single-threading: check-then-record with no await).
 *   - bounded (LRU of expired entries only; live consumed entries are never
 *     evicted — see W6-04 replay law)
 *   - expiry-aware cleanup
 *   - trust-generation binding (stale generation fails before consumption)
 *   - action/execution binding (digest + capability + tool + target)
 *   - fail-closed on every mismatch
 *
 * A pure diagnostic verifier may exist, but it NEVER authorizes execution.
 */

const ids = require("../mesh/ids");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");

const LEDGER_DEFAULTS = Object.freeze({
    maxEntries: 4096
});

class LeaseConsumptionLedger {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...LEDGER_DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** nonce -> { expiresAtMs, leaseId, executionId } (insertion = LRU order) */
        this._consumed = new Map();
    }

    /**
     * VERIFY + CONSUME — the ONE security operation an execution boundary
     * performs before running a tool. Throws typed failures on every
     * mismatch; on success the lease can NEVER be consumed again on this
     * node (replay fails closed).
     */
    /**
     * W6-R2-03: verifyAndConsume is THE execution-authorization operation.
     * Alias of consume() for semantic clarity at execution boundaries.
     */
    verifyAndConsume(lease, opts) {
        return this.consume(lease, opts);
    }

    consume(lease, {
        localNodeId, currentTrustGeneration, actionIntentCanonical,
        capabilityId, toolId, nowMs = null
    } = {}) {
        const at = Number.isFinite(nowMs) ? Math.floor(nowMs) : this.nowMs();
        // ---- structural + binding verification (fail-closed) ----
        if (!lease || typeof lease !== "object" || lease.schemaVersion !== 1) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "lease malformed or unsupported schemaVersion");
        }
        const recomputedActionDigest = require("../mesh/canonical").sha256Hex(actionIntentCanonical);
        if (lease.actionDigest !== recomputedActionDigest) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "action digest mismatch — intent changed after authorization");
        }
        if (lease.targetNodeId !== ids.check.nodeId(localNodeId)) {
            throw meshFailure(MESH_ERRORS.DESTINATION_MISMATCH, "lease bound to a different node");
        }
        if (lease.trustGeneration !== ids.check.trustGeneration(currentTrustGeneration)) {
            throw meshFailure(MESH_ERRORS.TRUST_GENERATION_STALE, "lease trust generation stale");
        }
        if (lease.capabilityId !== String(capabilityId ?? "").slice(0, 256)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "capability mismatch");
        }
        if (lease.toolId !== String(toolId ?? "").slice(0, 256)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "tool mismatch");
        }
        if (!Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= at) {
            throw meshFailure(MESH_ERRORS.MESSAGE_EXPIRED, "lease expired");
        }
        // ---- ATOMIC consume: check-then-record, synchronous (no await) ----
        const nonce = String(lease.executionNonce ?? "");
        if (!/^[0-9a-f]{32}$/.test(nonce)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "lease executionNonce malformed");
        }
        if (this._consumed.has(nonce)) {
            throw meshFailure(MESH_ERRORS.MESH_REPLAY, "lease already consumed on this node (one-use)");
        }
        this._sweepExpired(at);
        while (this._consumed.size >= this.config.maxEntries) {
            // LRU of consumed entries; LIVE entries are those not yet expired —
            // a consumed lease entry lives until its own expiry passes, so
            // eviction here only removes entries whose lease is already dead.
            const oldest = [...this._consumed.entries()].sort((x, y) => x[1].expiresAtMs - y[1].expiresAtMs)[0];
            if (!oldest || oldest[1].expiresAtMs > at) {
                // everything is still live: saturated -> fail-closed (W6-04 law)
                throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `lease consumption ledger saturated with live entries (${this.config.maxEntries})`);
            }
            this._consumed.delete(oldest[0]);
        }
        this._consumed.set(nonce, {
            expiresAtMs: lease.expiresAtMs,
            leaseId: String(lease.leaseId).slice(0, 128),
            executionId: `dexec-${nonce}`,
            consumedAtMs: at
        });
        return Object.freeze({
            consumed: true,
            executionId: `dexec-${nonce}`,
            leaseId: String(lease.leaseId).slice(0, 128),
            oneUseEnforced: true
        });
    }

    /** Diagnostics only — NEVER authorizes execution. */
    has(nonce) {
        return this._consumed.has(String(nonce ?? ""));
    }

    _sweepExpired(at) {
        for (const [nonce, rec] of this._consumed) {
            if (rec.expiresAtMs <= at) this._consumed.delete(nonce);
        }
    }

    size() { return this._consumed.size; }
}

module.exports = Object.freeze({ LeaseConsumptionLedger, LEDGER_DEFAULTS });
