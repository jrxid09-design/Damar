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
 maxEntries: 8192, // hard cap
 retentionMs: 10 * 60 * 1000 // entries older than this are swept
});

class MeshReplayGuard {
 constructor({ config = {}, nowMs = () => Date.now() } = {}) {
 this.config = Object.freeze({ ...DEFAULTS, ...config });
 this.nowMs = nowMs;
 /** key -> { expiresAtMs, acceptedAtMs } (insertion = LRU order) */
 this._seen = new Map();
 }

 static keyFor(envelope) {
 return `${ids.check.nodeId(envelope.sourceNodeId)}|${ids.check.meshMessageId(envelope.messageId)}`;
 }

 /**
  * W6-04 REPAIR — fail-closed saturation semantics.
  *
  * A still-valid consumed message MUST NOT become replayable merely because
  * an attacker floods unique IDs. Policy (option A + explicit overflow):
  * 1. sweep expired entries first (legitimate cleanup)
  * 2. if capacity is STILL saturated with LIVE entries -> reject the NEW
  * admission (BOUNDS_EXCEEDED). Live entries are NEVER evicted.
  * Expired consumed IDs can no longer pass the expiry gate at the router,
  * so forgetting them is safe.
  */
 accept(envelope) {
 const key = MeshReplayGuard.keyFor(envelope);
 const now = this.nowMs();
 this._sweep(now);
 if (this._seen.has(key)) {
 throw meshFailure(MESH_ERRORS.MESH_REPLAY, `duplicate message '${String(envelope.messageId).slice(0, 24)}' from '${String(envelope.sourceNodeId).slice(0, 24)}'`);
 }
 if (this._seen.size >= this.config.maxEntries) {
 // saturated with LIVE entries — fail closed: reject the new admission
 // (the sender retries later; live replay entries are never dropped)
 throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `replay ledger saturated with ${this.config.maxEntries} live entries; new admission rejected (fail-closed, no live eviction)`);
 }
 this._seen.set(key, { expiryBoundMs: Math.min(envelope.expiryMs, now + this.config.retentionMs), acceptedAtMs: now });
 return Object.freeze({ accepted: true, key });
 }

 /** Diagnostics only — NEVER authorizes anything. */
 seen(envelope) {
 return this._seen.has(MeshReplayGuard.keyFor(envelope));
 }

 _sweep(now) {
 for (const [key, rec] of this._seen) {
 if (rec.expiryBoundMs <= now) this._seen.delete(key);
 }
 }

 size() { return this._seen.size; }
}

module.exports = Object.freeze({ MeshReplayGuard, DEFAULTS });
