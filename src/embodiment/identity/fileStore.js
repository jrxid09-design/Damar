"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { fail, structuredCopy } = require("../core/util");

/**
 * DURABLE DEVICE IDENTITY FILE STORE (I§4) — production adapter for the
 * EXISTING IdentityStore port (store.js), Trust Foundation stage.
 *
 * This implements the EXISTING `save(serialized)` / `load()` contract of
 * Device Identity & Pairing.  It does NOT replace DeviceIdentityService,
 * serialize(), restore(), or the existing memory store, and it adds NO
 * human-Owner semantics and NO Authority semantics.
 *
 * LAW:
 *   - DEVICE IDENTITY != HUMAN OWNER.
 *   - DEVICE TRUST != OWNER AUTHORITY.
 *   - PERSISTED STATE != LIVE AUTHORITY.
 *
 * DURABILITY MODEL:
 *   - One snapshot file (the whole serialize() payload), written
 *     ATOMICALLY via tmp + rename (mode 0o600) so a crash mid-write never
 *     leaves a half-written canonical snapshot.
 *   - Saves are serialized through an in-process write queue so
 *     overlapping writes cannot silently corrupt canonical state.
 *   - load() returns the last durable snapshot, or null when none exists.
 *
 * FAIL-CLOSED:
 *   - A corrupt, truncated, or shape-invalid snapshot FAILS CLOSED: load()
 *     throws PID_INVALID_SERIALIZATION instead of returning an empty
 *     identity state.  We never silently reset to empty identity after
 *     corruption.
 *   - The snapshot's own rowDigests are validated by
 *     DeviceIdentityService.restore() downstream (this store validates the
 *     envelope shape; restore() validates the content, fail-closed).
 */

const STORE_BACKEND = "file-json-v1";
const SNAPSHOT_VERSION = 1;

function invalid(message) {
    return fail("PID_INVALID_SERIALIZATION", message);
}

/**
 * createFileIdentityStore(filePath, options)
 *
 * Durable production IdentityStore adapter for one atomic snapshot file.
 *
 * @param {string} filePath durable snapshot file path.
 * @param {object} [options]
 * @param {boolean} [options.fsync=true] fsync the snapshot on write.
 */
function createFileIdentityStore(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw fail("PID_NO_STORE", "file identity store memerlukan path berkas");
    }
    const fsync = options.fsync !== false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // In-process write queue: overlapping saves never interleave.
    let writing = false;
    const queue = [];
    function drain() {
        if (writing) return;
        writing = true;
        try {
            while (queue.length > 0) {
                const payload = queue.shift();
                const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                fs.writeFileSync(tmp, payload, { mode: 0o600 });
                if (fsync) {
                    const fd = fs.openSync(tmp, "r");
                    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                }
                fs.renameSync(tmp, filePath);
            }
        } finally {
            writing = false;
        }
    }

    /** Validate the envelope shape of a loaded snapshot (content is
     *  validated fail-closed by DeviceIdentityService.restore()). */
    function assertSnapshotShape(data) {
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
            throw invalid("snapshot identitas bukan objek");
        }
        if (data.version !== SNAPSHOT_VERSION) {
            throw invalid("snapshot identitas version tidak dikenal");
        }
        if (!Array.isArray(data.devices)) {
            throw invalid("snapshot identitas: devices bukan array");
        }
        if (!Array.isArray(data.transactions)) {
            throw invalid("snapshot identitas: transactions bukan array");
        }
        return data;
    }

    return {
        backend: STORE_BACKEND,

        /** Persist one serialize() payload atomically (deep-copied). */
        async save(serialized) {
            if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized)) {
                throw invalid("save() memerlukan snapshot serialisasi objek");
            }
            // Copy + write atomically; tmp+rename guards against torn writes.
            const payload = JSON.stringify(structuredCopy(serialized));
            queue.push(payload);
            drain();
            return true;
        },

        /** Load the last durable snapshot (deep-copied) or null if none. */
        async load() {
            let raw;
            try {
                raw = fs.readFileSync(filePath, "utf8");
            } catch {
                return null; // no durable snapshot yet
            }
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                throw invalid("snapshot identitas korup (bukan JSON)");
            }
            return assertSnapshotShape(structuredCopy(data));
        }
    };
}

module.exports = { createFileIdentityStore, STORE_BACKEND };
