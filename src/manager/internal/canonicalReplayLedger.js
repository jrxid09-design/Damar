"use strict";

// SQLite provides cross-process atomic reservation and FULL synchronous
// durability on both Windows and POSIX. This store is evidence only.
//
// INTEGRITY ARCHITECTURE:
// - HMAC chain links events: each event's HMAC includes the previous HMAC
// - Trusted anchor file (separate from mutable SQLite) stores the expected head
// - The anchor is fsync'd separately and contains HMAC(seq:event_hmac)
// - Truncation/rollback of SQLite alone cannot forge a matching anchor
// - Integrity key is separate from anchor to prevent key+anchor rollback
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sqlite3 = require("sqlite3");

const STATES = Object.freeze({
    RESERVED: "RESERVED", INVOKING: "INVOKING", EXECUTED_UNVERIFIED: "EXECUTED_UNVERIFIED",
    COMPLETED_VERIFIED: "COMPLETED_VERIFIED", AMBIGUOUS: "AMBIGUOUS",
    CANCELLED_BEFORE_EFFECT: "CANCELLED_BEFORE_EFFECT", FAILED: "FAILED", UNVERIFIED: "UNVERIFIED"
});

function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
function hmac(key, value) { return crypto.createHmac("sha256", key).update(value).digest("hex"); }
function dbCall(db, method, sql, params = []) {
    return new Promise((resolve, reject) => db[method](sql, params, function (error, row) {
        if (error) reject(error); else resolve(method === "run" ? { lastID: this.lastID, changes: this.changes } : row ?? null);
    }));
}

function syncDirectory(dir) {
    if (process.platform === "win32") {
        // Windows: directory fsync via fd fails with EPERM.
        // FlushFileBuffers on directory handle requires different Win32 API.
        // Instead, rely on FILE_FLAG_WRITE_THROUGH behavior of file fsync,
        // which flushes directory metadata when the file is flushed.
        // SQLite PRAGMA synchronous=FULL already ensures this for its own files.
        return;
    }
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureKey(file) {
    const keyFile = file + ".integrity-key";
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
        const fd = fs.openSync(keyFile, "wx", 0o600);
        const key = crypto.randomBytes(32);
        fs.writeSync(fd, key);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        syncDirectory(path.dirname(keyFile));
        return key;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Key file exists, but may not be fully written yet (race condition)
        // Wait briefly and retry up to 10 times
        for (let i = 0; i < 10; i++) {
            try {
                const key = fs.readFileSync(keyFile);
                if (key.length === 32) return key;
            } catch (readError) {
                // File might be mid-write, retry
            }
            // Busy-wait 10ms (total max 100ms)
            const deadline = Date.now() + 10;
            while (Date.now() < deadline) {}
        }
        // Final attempt
        const key = fs.readFileSync(keyFile);
        if (key.length !== 32) throw new Error("REPLAY_INTEGRITY_KEY_CORRUPT");
        return key;
    }
}

function writeTrustedAnchor(anchorFile, seq, eventHmac, key) {
    const anchorHmac = hmac(key, String(seq) + ":" + eventHmac);
    const payload = JSON.stringify({ seq, eventHmac, anchorHmac });
    const temp = anchorFile + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, anchorFile);
    // After atomic rename, sync directory on POSIX (no-op on Windows per syncDirectory logic)
    syncDirectory(path.dirname(anchorFile));
}

function readTrustedAnchor(anchorFile, key) {
    if (!fs.existsSync(anchorFile)) return null;
    try {
        const payload = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
        if (typeof payload.seq !== "number" || typeof payload.eventHmac !== "string" || typeof payload.anchorHmac !== "string") {
            throw new Error("REPLAY_ANCHOR_MALFORMED");
        }
        const expected = hmac(key, String(payload.seq) + ":" + payload.eventHmac);
        if (payload.anchorHmac !== expected) throw new Error("REPLAY_ANCHOR_CORRUPT");
        return { seq: payload.seq, eventHmac: payload.eventHmac };
    } catch (error) {
        throw new Error("REPLAY_ANCHOR_CORRUPT: " + error.message);
    }
}

function createCanonicalReplayLedger({ file = path.join(process.cwd(), "data", "audit", "canonical-replay.sqlite"), now = () => Date.now() } = {}) {
    const key = ensureKey(file);
    const anchorFile = file + ".anchor";
    const db = new sqlite3.Database(file);
    let ready = null;
    const open = () => ready ?? (ready = (async () => {
        await dbCall(db, "run", "PRAGMA journal_mode=WAL");
        await dbCall(db, "run", "PRAGMA synchronous=FULL");
        await dbCall(db, "run", "PRAGMA busy_timeout=10000");
        // replay_events: append-only HMAC chain audit trail
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL,state TEXT NOT NULL,capability_id TEXT,operation TEXT,principal TEXT,scope TEXT,authority_generation INTEGER,driver_id TEXT,at_ms INTEGER NOT NULL,prev_hmac TEXT NOT NULL,event_hmac TEXT NOT NULL)");
        await dbCall(db, "run", "CREATE INDEX IF NOT EXISTS idx_replay_digest ON replay_events(digest)");
        // replay_current: current state lookup with UNIQUE constraint for atomic reservation
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_current (digest TEXT PRIMARY KEY,state TEXT NOT NULL,capability_id TEXT,operation TEXT,principal TEXT,scope TEXT,authority_generation INTEGER,driver_id TEXT,at_ms INTEGER NOT NULL)");
    })());
    async function snapshot() {
        await open();
        const rows = await new Promise((resolve, reject) => db.all("SELECT * FROM replay_events ORDER BY seq", [], (e, r) => e ? reject(e) : resolve(r)));
        const anchor = readTrustedAnchor(anchorFile, key);
        let previous = "GENESIS";
        // Verify the append-only audit trail integrity
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r.seq !== i + 1 || r.prev_hmac !== previous || !Object.values(STATES).includes(r.state)) throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
            const core = { seq: r.seq, digest: r.digest, state: r.state, capabilityId: r.capability_id, operation: r.operation, principal: r.principal, scope: r.scope ? JSON.parse(r.scope) : null, authorityGeneration: r.authority_generation, driverId: r.driver_id, atMs: r.at_ms, prev: r.prev_hmac };
            if (hmac(key, canonical(core)) !== r.event_hmac) throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
            previous = r.event_hmac;
        }
        // Trusted anchor check: the anchor file is separate from the mutable SQLite db
        if ((anchor && (anchor.seq !== rows.length || anchor.eventHmac !== previous)) || (!anchor && rows.length)) {
            throw new Error("REPLAY_ANCHOR_MISMATCH");
        }
        // Read current state from the lookup table
        const current = await new Promise((resolve, reject) => db.all("SELECT * FROM replay_current", [], (e, r) => e ? reject(e) : resolve(r)));
        const latest = new Map();
        for (const r of current) {
            latest.set(r.digest, r);
        }
        return { rows, latest, previous };
    }
    async function append(binding, state, prior) {
        const seq = prior.rows.length + 1; const atMs = Math.floor(now());
        const core = { seq, digest: binding.digest, state, capabilityId: binding.capabilityId ?? null, operation: binding.operation ?? null, principal: binding.principal ?? null, scope: binding.scope ?? null, authorityGeneration: binding.authorityGeneration ?? null, driverId: binding.driverId ?? null, atMs, prev: prior.previous };
        const eventHmac = hmac(key, canonical(core));
        // Append to immutable audit trail
        await dbCall(db, "run", "INSERT INTO replay_events(seq,digest,state,capability_id,operation,principal,scope,authority_generation,driver_id,at_ms,prev_hmac,event_hmac) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [seq, core.digest, core.state, core.capabilityId, core.operation, core.principal, JSON.stringify(core.scope), core.authorityGeneration, core.driverId, atMs, core.prev, eventHmac]);
        // Update current state lookup table
        await dbCall(db, "run", "INSERT OR REPLACE INTO replay_current(digest,state,capability_id,operation,principal,scope,authority_generation,driver_id,at_ms) VALUES(?,?,?,?,?,?,?,?,?)", [core.digest, core.state, core.capabilityId, core.operation, core.principal, JSON.stringify(core.scope), core.authorityGeneration, core.driverId, atMs]);
        // Write trusted anchor OUTSIDE the mutable SQLite database
        writeTrustedAnchor(anchorFile, seq, eventHmac, key);
    }
    function sameBinding(r, b) { return r.capability_id === (b.capabilityId ?? null) && r.operation === (b.operation ?? null) && r.principal === (b.principal ?? null) && r.scope === JSON.stringify(b.scope ?? null) && r.authority_generation === (b.authorityGeneration ?? null) && r.driver_id === (b.driverId ?? null); }
    return Object.freeze({
        async reserve(binding = {}) {
            await open();
            await dbCall(db, "run", "BEGIN IMMEDIATE");
            try {
                const s = await snapshot();
                const prior = s.latest.get(binding.digest);
                if (prior) {
                    await dbCall(db, "run", "ROLLBACK");
                    if (!sameBinding(prior, binding)) throw new Error("REPLAY_LEDGER_BINDING_MISMATCH");
                    return { reserved: false, prior };
                }
                // Cross-process atomic reservation via PRIMARY KEY constraint on digest in replay_current.
                // If another process already inserted this digest, the append() will fail
                // with SQLITE_CONSTRAINT on the replay_current INSERT.
                await append(binding, STATES.RESERVED, s);
                await dbCall(db, "run", "COMMIT");
                return { reserved: true };
            }
            catch (error) {
                try { await dbCall(db, "run", "ROLLBACK"); } catch {}
                // SQLITE_CONSTRAINT (code 19) means another process won the race
                if (error.code === "SQLITE_CONSTRAINT" || error.errno === 19) {
                    // Re-read to get the winner's entry
                    await open();
                    const current = await dbCall(db, "get", "SELECT * FROM replay_current WHERE digest=?", [binding.digest]);
                    if (current && !sameBinding(current, binding)) throw new Error("REPLAY_LEDGER_BINDING_MISMATCH");
                    return { reserved: false, prior: current };
                }
                throw error;
            }
        },
        async transition(digest, state, binding = {}) {
            await open(); await dbCall(db, "run", "BEGIN IMMEDIATE");
            try { const s = await snapshot(); if (!s.latest.has(digest)) throw new Error("REPLAY_LEDGER_MISSING_RESERVATION"); await append({ ...binding, digest }, state, s); await dbCall(db, "run", "COMMIT"); return true; }
            catch (error) { try { await dbCall(db, "run", "ROLLBACK"); } catch {} throw error; }
        },
        async lookup(digest) {
            // Validate integrity before lookup
            const s = await snapshot();
            return s.latest.get(digest) ?? null;
        },
        filePath: file, STATES
    });
}

module.exports = { STATES, createCanonicalReplayLedger };
