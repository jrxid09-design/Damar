"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { fail, structuredCopy } = require("../core/util");
const CAPABILITY_ID = "embodiment.identity.snapshot.write";

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

function commitRefusal(result) {
    const commit = result?.verification?.checks?.find((check) => check?.name === "snapshot-commit-succeeded");
    const driverCode = typeof commit?.code === "string" ? commit.code : null;
    if (driverCode === "PID_SNAPSHOT_STALE") {
        const error = fail("PID_SNAPSHOT_CONFLICT", "snapshot identitas berubah sebelum commit; muat ulang state kanonik lalu coba lagi");
        error.retryable = true;
        error.causeCode = driverCode;
        return error;
    }
    if (driverCode === "PID_SNAPSHOT_BUSY") {
        return fail("PID_SNAPSHOT_BUSY", "snapshot identitas sedang dikunci oleh writer lain");
    }
    return invalid(`snapshot identitas ditolak: ${driverCode ?? result?.reason ?? result?.outcome ?? "UNKNOWN"}`);
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
    const fsync = true;

    const capabilityRuntime = options.capabilityRuntime;
    if (!capabilityRuntime || typeof capabilityRuntime.execute !== "function") {
        throw new TypeError("file identity store requires the Manager-owned capability runtime");
    }

    // In-process write queue: overlapping saves never interleave (FIFO), and
    // each caller settles on ITS OWN commit (P3-3). A shared last-result slot
    // could hand one caller another save's revision, or another save's
    // refusal — and a refusal must poison exactly the service that issued the
    // stale write, never a sibling writer.
    let tail = Promise.resolve();

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
            const commit = tail.then(async () => {
                const result = await capabilityRuntime.execute({
                    capabilityId: CAPABILITY_ID, operation: "save",
                    parameters: { filePath, payload, fsync }
                });
                if (result?.outcome !== "EXECUTED_VERIFIED") throw commitRefusal(result);
                return result.result ?? result;
            });
            // Keep the queue alive across a refusal: the next save still runs,
            // but the refusal belongs only to the caller that issued it.
            tail = commit.then(() => undefined, () => undefined);
            const result = await commit;
            return { snapshotRevision: result?.snapshotRevision ?? JSON.parse(payload).snapshotRevision };
        },

        /** Load the last durable snapshot (deep-copied) or null if none. */
        async load() {
            let raw;
            try {
                raw = fs.readFileSync(filePath, "utf8");
            } catch (error) {
                // TF-004 READ FAILURE: ONLY true file-not-found (ENOENT) may
                // mean "no snapshot yet".  Permission errors, a directory
                // path, I/O failures, or any other read error are NOT "fresh
                // state" — an initialized-but-unreadable state must never be
                // interpreted as a clean slate.  Fail closed.
                if (error && error.code === "ENOENT") {
                    return null; // genuinely no durable snapshot yet
                }
                throw invalid(
                    `gagal membaca snapshot identitas (${error && error.code ? error.code : "IO"})`);
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
