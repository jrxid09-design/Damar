"use strict";

// SQLite provides cross-process atomic reservation and FULL synchronous
// durability on both Windows and POSIX. This store is evidence only.
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
function ensureKey(file) {
    const keyFile = file + ".integrity-key";
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
        const fd = fs.openSync(keyFile, "wx", 0o600);
        const key = crypto.randomBytes(32);
        fs.writeSync(fd, key); fs.fsyncSync(fd); fs.closeSync(fd); return key;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const key = fs.readFileSync(keyFile);
        if (key.length !== 32) throw new Error("REPLAY_INTEGRITY_KEY_CORRUPT");
        return key;
    }
}

function createCanonicalReplayLedger({ file = path.join(process.cwd(), "data", "audit", "canonical-replay.sqlite"), now = () => Date.now() } = {}) {
    const key = ensureKey(file);
    const db = new sqlite3.Database(file);
    let ready = null;
    const open = () => ready ?? (ready = (async () => {
        await dbCall(db, "run", "PRAGMA journal_mode=WAL");
        await dbCall(db, "run", "PRAGMA synchronous=FULL");
        await dbCall(db, "run", "PRAGMA busy_timeout=10000");
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL,state TEXT NOT NULL,capability_id TEXT,operation TEXT,principal TEXT,scope TEXT,authority_generation INTEGER,driver_id TEXT,at_ms INTEGER NOT NULL,prev_hmac TEXT NOT NULL,event_hmac TEXT NOT NULL)");
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_head (id INTEGER PRIMARY KEY CHECK(id=1),seq INTEGER NOT NULL,event_hmac TEXT NOT NULL,anchor_hmac TEXT NOT NULL)");
    })());
    async function snapshot() {
        await open();
        const rows = await new Promise((resolve, reject) => db.all("SELECT * FROM replay_events ORDER BY seq", [], (e, r) => e ? reject(e) : resolve(r)));
        const head = await dbCall(db, "get", "SELECT * FROM replay_head WHERE id=1");
        let previous = "GENESIS"; const latest = new Map();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r.seq !== i + 1 || r.prev_hmac !== previous || !Object.values(STATES).includes(r.state)) throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
            const core = { seq: r.seq, digest: r.digest, state: r.state, capabilityId: r.capability_id, operation: r.operation, principal: r.principal, scope: r.scope ? JSON.parse(r.scope) : null, authorityGeneration: r.authority_generation, driverId: r.driver_id, atMs: r.at_ms, prev: r.prev_hmac };
            if (hmac(key, canonical(core)) !== r.event_hmac) throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
            previous = r.event_hmac; latest.set(r.digest, r);
        }
        if ((head && (head.seq !== rows.length || head.event_hmac !== previous || head.anchor_hmac !== hmac(key, String(head.seq) + ":" + head.event_hmac))) || (!head && rows.length)) throw new Error("REPLAY_LEDGER_HEAD_CORRUPT");
        return { rows, latest, previous };
    }
    async function append(binding, state, prior) {
        const seq = prior.rows.length + 1; const atMs = Math.floor(now());
        const core = { seq, digest: binding.digest, state, capabilityId: binding.capabilityId ?? null, operation: binding.operation ?? null, principal: binding.principal ?? null, scope: binding.scope ?? null, authorityGeneration: binding.authorityGeneration ?? null, driverId: binding.driverId ?? null, atMs, prev: prior.previous };
        const eventHmac = hmac(key, canonical(core));
        await dbCall(db, "run", "INSERT INTO replay_events(seq,digest,state,capability_id,operation,principal,scope,authority_generation,driver_id,at_ms,prev_hmac,event_hmac) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [seq, core.digest, core.state, core.capabilityId, core.operation, core.principal, JSON.stringify(core.scope), core.authorityGeneration, core.driverId, atMs, core.prev, eventHmac]);
        await dbCall(db, "run", "INSERT OR REPLACE INTO replay_head(id,seq,event_hmac,anchor_hmac) VALUES(1,?,?,?)", [seq, eventHmac, hmac(key, String(seq) + ":" + eventHmac)]);
    }
    function sameBinding(r, b) { return r.capability_id === (b.capabilityId ?? null) && r.operation === (b.operation ?? null) && r.principal === (b.principal ?? null) && r.scope === JSON.stringify(b.scope ?? null) && r.authority_generation === (b.authorityGeneration ?? null) && r.driver_id === (b.driverId ?? null); }
    return Object.freeze({
        async reserve(binding = {}) {
            await open(); await dbCall(db, "run", "BEGIN IMMEDIATE");
            try { const s = await snapshot(); const prior = s.latest.get(binding.digest); if (prior) { await dbCall(db, "run", "ROLLBACK"); if (!sameBinding(prior, binding)) throw new Error("REPLAY_LEDGER_BINDING_MISMATCH"); return { reserved: false, prior }; } await append(binding, STATES.RESERVED, s); await dbCall(db, "run", "COMMIT"); return { reserved: true }; }
            catch (error) { try { await dbCall(db, "run", "ROLLBACK"); } catch {} throw error; }
        },
        async transition(digest, state, binding = {}) {
            await open(); await dbCall(db, "run", "BEGIN IMMEDIATE");
            try { const s = await snapshot(); if (!s.latest.has(digest)) throw new Error("REPLAY_LEDGER_MISSING_RESERVATION"); await append({ ...binding, digest }, state, s); await dbCall(db, "run", "COMMIT"); return true; }
            catch (error) { try { await dbCall(db, "run", "ROLLBACK"); } catch {} throw error; }
        },
        async lookup(digest) { const s = await snapshot(); return s.latest.get(digest) ?? null; },
        filePath: file, STATES
    });
}

module.exports = { STATES, createCanonicalReplayLedger };
