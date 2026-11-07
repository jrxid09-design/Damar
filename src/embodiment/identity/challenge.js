/**
 * ChallengeBroker (I§2) — short-lived, single-use pairing challenges.
 *
 * Contract:
 *   - secret is high-entropy and returned EXACTLY once at issue time;
 *     only its SHA-256 digest is retained.
 *   - a challenge is bound to one {pairingId, deviceId} transaction.
 *   - single-use: successful consume deletes the entry (replay-proof).
 *   - deterministic expiry via injected clock; expired entries reclaimed.
 *   - bounded capacity with oldest-first reclamation.
 *   - a challenge can never become Authority — it only proves intent of
 *     one specific pending pairing transaction.
 */

const crypto = require("node:crypto");
const { fail, sha256Hex } = require("../core/util");

const DEFAULTS = Object.freeze({
    ttlMs: 120_000,
    capacity: 16,
    maxAttempts: 5
});

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString("hex");
}

class ChallengeBroker {

    constructor({ clock, config = {}, entropy = null } = {}) {
        this.clock = clock;
        this.config = deepConfig(DEFAULTS, config);
        this._entropy = entropy ?? (() => randomHex(32));
        /** challengeId -> entry */
        this._challenges = new Map();
    }

    /**
     * Issue a challenge for one pairing transaction. The secret MUST be
     * delivered out-of-band to the intended device; it is not stored.
     */
    issue({ pairingId, deviceId }) {
        this.prune();
        while (this._challenges.size >= this.config.capacity) {
            const oldest = this._challenges.keys().next().value;
            this._challenges.delete(oldest);
        }
        const now = this.clock.nowMs();
        const secret = String(this._entropy());
        const entry = {
            digest: sha256Hex(secret),
            pairingId: String(pairingId),
            deviceId: String(deviceId),
            issuedAtMs: now,
            expiresAtMs: now + this.config.ttlMs
        };
        const challengeId = `chg-${randomHex(12)}`;
        this._challenges.set(challengeId, entry);
        return {
            challengeId, secret,
            expiresAtMs: entry.expiresAtMs
        };
    }

    /**
     * Consume a challenge. Throws coded errors; on ANY failure path that
     * keeps the entry alive, attempt accounting applies and exhausting
     * attempts reclaims the entry (brute-force bounded).
     */
    consume({ challengeId, secret, pairingId, deviceId }) {
        // NOTE: no eager prune here — an expired-but-present entry must be
        // reported as EXPIRED deterministically; reclamation happens via
        // capacity eviction or explicit prune.
        const id = String(challengeId ?? "");
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)
            || typeof secret !== "string" || secret.length === 0
            || secret.length > 256) {
            throw fail("PID_CHALLENGE_MALFORMED", "bentuk tantangan tidak sah");
        }
        const entry = this._challenges.get(id);
        if (!entry) {
            // Covers unknown ids AND already-consumed (replay) ones.
            throw fail("PID_CHALLENGE_NOT_FOUND",
                "tantangan tidak dikenal atau sudah dipakai");
        }
        if (this.clock.nowMs() >= entry.expiresAtMs) {
            this._challenges.delete(id);
            throw fail("PID_CHALLENGE_EXPIRED", "tantangan kedaluwarsa");
        }
        if (entry.deviceId !== String(deviceId)) {
            throw fail("PID_CHALLENGE_WRONG_DEVICE",
                "tantangan tidak terikat ke perangkat ini");
        }
        if (entry.pairingId !== String(pairingId)) {
            throw fail("PID_CHALLENGE_WRONG_TX",
                "tantangan tidak terikat ke transaksi pairing ini");
        }
        if (sha256Hex(secret) !== entry.digest) {
            entry.attempts = (entry.attempts ?? 0) + 1;
            if (entry.attempts >= this.config.maxAttempts) {
                this._challenges.delete(id);
                throw fail("PID_CHALLENGE_EXHAUSTED",
                    "terlalu banyak percobaan tantangan salah");
            }
            throw fail("PID_CHALLENGE_MISMATCH", "rahasia tantangan salah");
        }
        this._challenges.delete(id);   // single-use: replay impossible
        return true;
    }

    invalidateDevice(deviceId) {
        let n = 0;
        for (const [id, e] of this._challenges) {
            if (e.deviceId === deviceId) { this._challenges.delete(id); n++; }
        }
        return n;
    }

    invalidatePairing(pairingId) {
        let n = 0;
        for (const [id, e] of this._challenges) {
            if (e.pairingId === pairingId) { this._challenges.delete(id); n++; }
        }
        return n;
    }

    prune() {
        const now = this.clock.nowMs();
        for (const [id, e] of this._challenges) {
            if (now >= e.expiresAtMs) this._challenges.delete(id);
        }
    }

    size() { this.prune(); return this._challenges.size; }

}

function deepConfig(defaults, overrides) {
    return Object.freeze({ ...defaults, ...overrides });
}

module.exports = { ChallengeBroker, CHALLENGE_DEFAULTS: DEFAULTS };
