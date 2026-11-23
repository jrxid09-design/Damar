"use strict";
// MCP Lane 2 grant store (ratified 2026-11-23; composition wiring
// 2026-11-24). The canonical grant verifier (ownerGrant.makeGrantVerifier)
// rehydrates grants from a store by grantId, so revocation and expiry
// always reflect CURRENT store state. This module provides that store:
//
//   - createFileGrantStore(filePath): durable JSON file store. Records
//     live beside the canonical Owner Trust state (same trusted host
//     directory, derived by the composition root - never caller-chosen
//     at request time). Writes are atomic (tmp file + rename) and the
//     in-memory snapshot is re-read from disk on every mutation, so a
//     Console revoke is visible to the verifier immediately.
//   - createMemoryGrantStore(): the same contract, process-local (tests
//     and the non-durable "memory" composition mode).
//
// Store contract (synchronous, matching the canonical verifier):
//   get(grantId)      -> { grant, signature, revoked } | null
//   put(record)       -> record (record.grant.grantId required)
//   markRevoked(id)   -> boolean (false when unknown)
//   list()            -> array of records (defensive copies)
//
// The store holds owner-SIGNED grants + their signatures. It never holds
// private keys: the owner private key stays in the vault ceremony path,
// and worker private keys never leave the worker.
const fs = require("fs");
const path = require("path");

function cloneRecord(rec) {
    if (!rec || typeof rec !== "object" || !rec.grant || typeof rec.grant !== "object") return null;
    return {
        grant: JSON.parse(JSON.stringify(rec.grant)),
        signature: typeof rec.signature === "string" ? rec.signature : null,
        revoked: rec.revoked === true,
    };
}

function validateRecord(rec) {
    const clean = cloneRecord(rec);
    if (!clean) throw new TypeError("grant record must carry a grant object");
    if (typeof clean.grant.grantId !== "string" || clean.grant.grantId.length === 0) {
        throw new TypeError("grant record requires grant.grantId");
    }
    if (typeof clean.signature !== "string" || clean.signature.length === 0) {
        throw new TypeError("grant record requires a signature");
    }
    return clean;
}

function createMemoryGrantStore() {
    const records = new Map();
    return Object.freeze({
        get(grantId) {
            const rec = records.get(grantId);
            return rec ? cloneRecord(rec) : null;
        },
        put(record) {
            const clean = validateRecord(record);
            records.set(clean.grant.grantId, clean);
            return cloneRecord(clean);
        },
        markRevoked(grantId) {
            const rec = records.get(grantId);
            if (!rec) return false;
            rec.revoked = true;
            return true;
        },
        list() {
            return [...records.values()].map(cloneRecord);
        },
    });
}

function createFileGrantStore(filePath) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw new TypeError("createFileGrantStore requires a file path");
    }
    const resolved = path.resolve(filePath);
    let cache = null; // Map<grantId, record>

    function load() {
        if (cache !== null) return cache;
        cache = new Map();
        try {
            const raw = fs.readFileSync(resolved, "utf8");
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : parsed?.records;
            if (Array.isArray(arr)) {
                for (const rec of arr) {
                    const clean = cloneRecord(rec);
                    if (clean && typeof clean.grant.grantId === "string") {
                        cache.set(clean.grant.grantId, clean);
                    }
                }
            }
        } catch (err) {
            if (err && err.code !== "ENOENT") {
                // A corrupt store must not silently mint trust: start empty
                // (fail-closed - every lookup misses) but keep the error
                // visible to the composition via the load error marker.
                cache.loadError = String(err && err.message || err);
            }
        }
        return cache;
    }

    function persist() {
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${resolved}.tmp-${process.pid}`;
        const body = JSON.stringify({ version: 1, records: [...load().values()] }, null, 2);
        fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, resolved);
    }

    return Object.freeze({
        filePath: resolved,
        get(grantId) {
            const rec = load().get(grantId);
            return rec ? cloneRecord(rec) : null;
        },
        put(record) {
            const clean = validateRecord(record);
            load().set(clean.grant.grantId, clean);
            persist();
            return cloneRecord(clean);
        },
        markRevoked(grantId) {
            const rec = load().get(grantId);
            if (!rec) return false;
            rec.revoked = true;
            persist();
            return true;
        },
        list() {
            return [...load().values()].map(cloneRecord);
        },
    });
}

module.exports = { createFileGrantStore, createMemoryGrantStore };
