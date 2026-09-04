"use strict";

/**
 * Owner Trust Registry — durable store port.
 *
 * Same contract discipline as the Device Identity file store (TF stage):
 * one atomic snapshot file (tmp + rename, mode 0o600), an in-process write
 * queue, fail-closed load.  This is the persistence boundary ONLY; it holds
 * NO trust logic and NO secret material.
 */

const fs = require("node:fs");
const path = require("node:path");

const { RECORD_VERSION } = require("./types");

const STORE_BACKEND = "ownerTrust-file-json-v1";

function invalid(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function assertSnapshotShape(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
        throw invalid("OT_INVALID_SERIALIZATION", "ownerTrust snapshot bukan objek");
    }
    if (data.version !== RECORD_VERSION) {
        throw invalid("OT_INVALID_SERIALIZATION", "ownerTrust snapshot version tidak dikenal");
    }
    if (typeof data.state !== "string") {
        throw invalid("OT_INVALID_SERIALIZATION", "ownerTrust snapshot: state tidak sah");
    }
    return data;
}

function createOwnerTrustStore(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw invalid("OT_NO_STORE", "ownerTrust store memerlukan path berkas");
    }
    const fsync = options.fsync !== false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    let writing = false;
    const queue = [];
    function cleanupTmp(tmp) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    }
    function drain() {
        if (writing) return;
        writing = true;
        try {
            while (queue.length > 0) {
                const payload = queue.shift();
                const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                try {
                    fs.writeFileSync(tmp, payload, { mode: 0o600 });
                    if (fsync) {
                        const fd = fs.openSync(tmp, "r+");
                        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
                    }
                    fs.renameSync(tmp, filePath);
                } catch (error) {
                    cleanupTmp(tmp);
                    throw invalid("OT_STORE_FAILURE", `gagal menulis ownerTrust snapshot: ${error.message}`);
                }
            }
        } finally {
            writing = false;
        }
    }

    return {
        backend: STORE_BACKEND,
        async save(serialized) {
            if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized)) {
                throw invalid("OT_INVALID_SERIALIZATION", "save() memerlukan snapshot objek");
            }
            const payload = JSON.stringify(serialized);
            queue.push(payload);
            drain();
            return true;
        },
        async load() {
            let raw;
            try {
                raw = fs.readFileSync(filePath, "utf8");
            } catch (error) {
                if (error && error.code === "ENOENT") return null;
                throw invalid("OT_INVALID_SERIALIZATION",
                    `gagal membaca ownerTrust snapshot (${error && error.code ? error.code : "IO"})`);
            }
            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                throw invalid("OT_INVALID_SERIALIZATION", "ownerTrust snapshot korup (bukan JSON)");
            }
            return assertSnapshotShape(data);
        }
    };
}

module.exports = Object.freeze({ createOwnerTrustStore, STORE_BACKEND });
