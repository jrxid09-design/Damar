"use strict";

// SQLite provides cross-process atomic reservation (BEGIN IMMEDIATE) and FULL
// synchronous durability on both Windows and POSIX. This store is evidence only.
//
// INTEGRITY ARCHITECTURE (after audit of f73b01b):
// - replay_events is the ONLY replay truth. It is an append-only HMAC chain:
//   each event's HMAC is HMAC(key, canonicalJson(core)) where core.prev is the
//   previous event's HMAC. Current state is DERIVED from this authenticated
//   history on every transaction boundary; there is no separate trusted
//   "current" table. (REPLAY_CACHE != REPLAY_AUTHORITY)
// - A KEYED anchor file stores the expected head as HMAC(key, "seq:hmac"), so
//   tampering with, mutating, reordering, injecting into, or truncating the
//   SQLite db ALONE is detected and the store fails closed.
// - Cross-process atomicity comes from BEGIN IMMEDIATE (a single writer at a
//   time) plus a check-then-append inside that exclusive transaction.
//
// ROLLBACK BOUNDARY (P0-2):
// The key and the anchor are separate files but co-located, and no monotonic
// local primitive survives whole-directory replacement. Therefore an optional
// EXTERNAL rollback anchor port may be supplied:
//   { read(): { seq: number, token: string } | null , commit(seq, token): void }
// The port MUST live outside the rollback domain (remote/monotonic/OS-protected)
// and MUST be durable before commit() returns. When a port is configured, a
// local head that is behind (or inconsistent with) the external head fails
// closed with REPLAY_ROLLBACK_DETECTED. When NO port is configured the store
// reports rollbackResistance="NONE" and consequential execution is refused
// upstream. Whole-directory rollback is NOT detectable from local files alone
// and is never claimed to be.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sqlite3 = require("sqlite3");
const { canonicalJson } = require("../../runtime/auditLedger/canonicalJson");

const STATES = Object.freeze({
    RESERVED: "RESERVED", INVOKING: "INVOKING", EXECUTED_UNVERIFIED: "EXECUTED_UNVERIFIED",
    COMPLETED_VERIFIED: "COMPLETED_VERIFIED", AMBIGUOUS: "AMBIGUOUS",
    CANCELLED_BEFORE_EFFECT: "CANCELLED_BEFORE_EFFECT", FAILED: "FAILED", UNVERIFIED: "UNVERIFIED"
});

function hmac(key, value) { return crypto.createHmac("sha256", key).update(value).digest("hex"); }
function dbCall(db, method, sql, params = []) {
    return new Promise((resolve, reject) => db[method](sql, params, function (error, row) {
        if (error) reject(error); else resolve(method === "run" ? { lastID: this.lastID, changes: this.changes } : row ?? null);
    }));
}

function syncDirectory(dir) {
    if (process.platform === "win32") {
        // Node exposes NO directory-fsync primitive on Windows (fsync on a
        // directory fd fails with EPERM) and fs.fsyncSync does NOT set
        // FILE_FLAG_WRITE_THROUGH. This is deliberately a no-op, not a faked
        // success; Windows durability is provided at the FILE level by the
        // writer itself (fsync -> FlushFileBuffers); see writeTrustedAnchor().
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
        // Exists but may still be mid-write by a racing creator.
        for (let i = 0; i < 10; i++) {
            try {
                const key = fs.readFileSync(keyFile);
                if (key.length === 32) return key;
            } catch { /* mid-write, retry */ }
            const deadline = Date.now() + 10;
            while (Date.now() < deadline) { /* bounded spin */ }
        }
        const key = fs.readFileSync(keyFile);
        if (key.length !== 32) throw new Error("REPLAY_INTEGRITY_KEY_CORRUPT");
        return key;
    }
}

function writeTrustedAnchor(anchorFile, seq, eventHmac, key) {
    const anchorHmac = hmac(key, String(seq) + ":" + eventHmac);
    const payload = JSON.stringify({ seq, eventHmac, anchorHmac });

    // NON-DESTRUCTIVE WRITE (every platform): stage the full payload in a temp
    // file, fsync it, THEN atomically replace the live anchor. The live file is
    // never truncated before the new payload is durable, so a mid-write I/O
    // failure (disk full, AV lock, kill, power loss) leaves the PREVIOUS valid
    // anchor intact and recoverable via snapshot()'s BEHIND reconciliation
    // instead of corrupting it into a permanent ledger-wide denial of service.
    // The win32 rename-durability caveat is unchanged and documented: Node sets
    // no MOVEFILE_WRITE_THROUGH, so the rename's directory entry is not forced
    // to disk; the rename still gives readers atomic replacement.
    const temp = anchorFile + ".tmp";
    const fd = fs.openSync(temp, "w", 0o600);
    try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temp, anchorFile);
    syncDirectory(path.dirname(anchorFile));
}
function readTrustedAnchor(anchorFile, key) {
    if (!fs.existsSync(anchorFile)) return null;
    try {
        const payload = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
        if (!Number.isSafeInteger(payload.seq) || typeof payload.eventHmac !== "string" || typeof payload.anchorHmac !== "string") {
            throw new Error("REPLAY_ANCHOR_MALFORMED");
        }
        const expected = hmac(key, String(payload.seq) + ":" + payload.eventHmac);
        if (payload.anchorHmac !== expected) throw new Error("REPLAY_ANCHOR_CORRUPT");
        return { seq: payload.seq, eventHmac: payload.eventHmac };
    } catch (error) {
        throw new Error("REPLAY_ANCHOR_CORRUPT: " + error.message);
    }
}

function eventCore(row) {
    return {
        seq: row.seq, digest: row.digest, state: row.state,
        capabilityId: row.capability_id, operation: row.operation,
        principal: row.principal,
        scope: row.scope ? JSON.parse(row.scope) : null,
        authorityGeneration: row.authority_generation,
        driverId: row.driver_id, atMs: row.at_ms, prev: row.prev_hmac
    };
}

function createCanonicalReplayLedger({
    file = path.join(process.cwd(), "data", "audit", "canonical-replay.sqlite"),
    now = () => Date.now(),
    rollbackAnchor = null
} = {}) {
    if (rollbackAnchor !== null) {
        if (typeof rollbackAnchor !== "object" ||
            typeof rollbackAnchor.read !== "function" ||
            typeof rollbackAnchor.commit !== "function") {
            throw new TypeError("rollbackAnchor must be a port with read() and commit()");
        }
    }

    const key = ensureKey(file);
    const anchorFile = file + ".anchor";
    const db = new sqlite3.Database(file);
    let ready = null;
    const open = () => ready ?? (ready = (async () => {
        await dbCall(db, "run", "PRAGMA journal_mode=WAL");
        await dbCall(db, "run", "PRAGMA synchronous=FULL");
        await dbCall(db, "run", "PRAGMA busy_timeout=10000");
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL,state TEXT NOT NULL,capability_id TEXT,operation TEXT,principal TEXT,scope TEXT,authority_generation INTEGER,driver_id TEXT,at_ms INTEGER NOT NULL,prev_hmac TEXT NOT NULL,event_hmac TEXT NOT NULL)");
        await dbCall(db, "run", "CREATE INDEX IF NOT EXISTS idx_replay_digest ON replay_events(digest)");
        // P0-1: replay_current is no longer a trusted source. Drop any legacy
        // table so no unauthenticated cache can ever influence execution.
        await dbCall(db, "run", "DROP TABLE IF EXISTS replay_current");
    })());

    async function snapshot() {
        await open();
        // A reader can straddle a concurrent writer's COMMIT + anchor-persist and
        // observe a fresh anchor over a stale row snapshot. That benign timing is
        // retried (bounded); genuine truncation never self-heals and fails closed.
        // Under BEGIN IMMEDIATE writers are excluded, so an AHEAD anchor there is
        // real tamper and simply exhausts the retries.
        for (let attempt = 0; ; attempt++) {
            const rows = await new Promise((resolve, reject) =>
                db.all("SELECT * FROM replay_events ORDER BY seq", [], (e, r) => e ? reject(e) : resolve(r)));

            // Authenticated history is the ONLY source of current state.
            let previous = "GENESIS";
            const latest = new Map();
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (r.seq !== i + 1 || r.prev_hmac !== previous || !Object.values(STATES).includes(r.state)) {
                    throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
                }
                let canonicalCore;
                try { canonicalCore = canonicalJson(eventCore(r)); }
                catch { throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE"); }
                if (hmac(key, canonicalCore) !== r.event_hmac) throw new Error("REPLAY_LEDGER_INTEGRITY_FAILURE");
                previous = r.event_hmac;
                latest.set(r.digest, r);   // last occurrence wins: derived current state
            }

            // Local keyed anchor: detects db-only tampering/truncation.
            //
            // DIRECTIONAL RECONCILIATION: the anchor is a CACHE of the authenticated
            // head. Anchor AHEAD of the chain = committed history was truncated without
            // the anchor moving -> tamper -> FAIL CLOSED. Anchor BEHIND the chain can
            // only come from our own anchor write failing (rows are HMAC-authenticated),
            // so it is REPAIRED forward instead of poisoning the ledger.
            const anchor = readTrustedAnchor(anchorFile, key);
            if (rows.length === 0) {
                if (anchor && anchor.seq !== 0) throw new Error("REPLAY_ANCHOR_MISMATCH");
            } else if (!anchor) {
                throw new Error("REPLAY_ANCHOR_MISMATCH");
            } else if (anchor.seq > rows.length) {
                if (attempt < 3) { await new Promise((r) => setTimeout(r, 2)); continue; }
                throw new Error("REPLAY_ANCHOR_MISMATCH");
            } else if (anchor.seq < rows.length) {
                const prefixHmac = anchor.seq >= 1 ? rows[anchor.seq - 1].event_hmac : null;
                if (prefixHmac === null || prefixHmac !== anchor.eventHmac) throw new Error("REPLAY_ANCHOR_MISMATCH");
                writeTrustedAnchor(anchorFile, rows.length, previous, key);
            } else if (anchor.eventHmac !== previous) {
                throw new Error("REPLAY_ANCHOR_MISMATCH");
            }

            // External rollback anchor: detects whole-local-state rollback.
            if (rollbackAnchor) {
                let external;
                try { external = rollbackAnchor.read(); }
                catch { throw new Error("REPLAY_ROLLBACK_ANCHOR_UNAVAILABLE"); }
                const externalSeq = external && Number.isSafeInteger(external.seq) ? external.seq : 0;
                const externalToken = external && typeof external.token === "string" ? external.token : null;
                if (externalSeq > rows.length) {
                    throw new Error("REPLAY_ROLLBACK_DETECTED");
                }
                if (externalSeq < rows.length) {
                    try { rollbackAnchor.commit(rows.length, previous); }
                    catch { throw new Error("REPLAY_ROLLBACK_ANCHOR_UNAVAILABLE"); }
                } else if (rows.length > 0 && externalToken !== previous) {
                    throw new Error("REPLAY_ROLLBACK_DETECTED");
                }
            }

            return { rows, latest, previous };
        }
    }

    /** INSERT one authenticated event. Returns its hmac. Anchors are NOT written
     *  here: they are persisted only AFTER the enclosing transaction COMMITs, so
     *  a failed commit can never leave an anchor AHEAD of committed history. */
    async function insertEvent(binding, state, prior) {
        const seq = prior.rows.length + 1;
        const atMs = Math.floor(now());
        const core = {
            seq, digest: binding.digest, state,
            capabilityId: binding.capabilityId ?? null,
            operation: binding.operation ?? null,
            principal: binding.principal ?? null,
            scope: binding.scope ?? null,
            authorityGeneration: binding.authorityGeneration ?? null,
            driverId: binding.driverId ?? null,
            atMs, prev: prior.previous
        };
        let canonicalCore;
        try { canonicalCore = canonicalJson(core); }
        catch { throw new Error("REPLAY_EVENT_NOT_CANONICAL"); }
        const eventHmac = hmac(key, canonicalCore);

        await dbCall(db, "run", "INSERT INTO replay_events(seq,digest,state,capability_id,operation,principal,scope,authority_generation,driver_id,at_ms,prev_hmac,event_hmac) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            [seq, core.digest, core.state, core.capabilityId, core.operation, core.principal,
             JSON.stringify(core.scope), core.authorityGeneration, core.driverId, atMs, core.prev, eventHmac]);

        return { seq, eventHmac };
    }

    /** Persist the head AFTER a successful COMMIT. A failure here leaves the
     *  anchor BEHIND the authenticated chain, which snapshot() repairs forward;
     *  the committed reservation stays consumed, so no duplicate effect occurs. */
    async function persistAnchors(seq, eventHmac) {
        writeTrustedAnchor(anchorFile, seq, eventHmac, key);
        if (rollbackAnchor) {
            try { rollbackAnchor.commit(seq, eventHmac); }
            catch { throw new Error("REPLAY_ROLLBACK_ANCHOR_COMMIT_FAILED"); }
        }
    }

    function sameBinding(r, b) {
        return r.capability_id === (b.capabilityId ?? null) &&
            r.operation === (b.operation ?? null) &&
            r.principal === (b.principal ?? null) &&
            r.scope === JSON.stringify(b.scope ?? null) &&
            r.authority_generation === (b.authorityGeneration ?? null) &&
            r.driver_id === (b.driverId ?? null);
    }

    // In-process serialization. SQLite BEGIN IMMEDIATE is cross-process
    // exclusive, but ONE sqlite3 connection cannot hold two write transactions
    // at once, and concurrent callers on a single ledger instance are real
    // (e.g. Promise.all over two bridge executions). Unserialized, the second
    // BEGIN IMMEDIATE fails and a legitimate effect is reported UNVERIFIED.
    // Cross-process atomicity still comes from BEGIN IMMEDIATE.
    let chain = Promise.resolve();
    function serialize(fn) {
        const next = chain.then(() => fn());
        chain = next.then(() => undefined, () => undefined);
        return next;
    }

    return Object.freeze({
        // Honest classification. "EXTERNAL" requires a configured port outside
        // the rollback domain; consequential execution requires "EXTERNAL".
        rollbackResistance: rollbackAnchor ? "EXTERNAL" : "NONE",

        reserve(binding = {}) { return serialize(() => this._reserve(binding)); },
        transition(digest, state, binding = {}) { return serialize(() => this._transition(digest, state, binding)); },
        lookup(digest) { return serialize(() => this._lookup(digest)); },


        async _reserve(binding = {}) {
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
                const { seq, eventHmac } = await insertEvent(binding, STATES.RESERVED, s);
                await dbCall(db, "run", "COMMIT");
                await persistAnchors(seq, eventHmac);
                return { reserved: true };
            } catch (error) {
                try { await dbCall(db, "run", "ROLLBACK"); } catch { /* already rolled back */ }
                throw error;
            }
        },

        async _transition(digest, state, binding = {}) {
            await open();
            await dbCall(db, "run", "BEGIN IMMEDIATE");
            try {
                const s = await snapshot();
                if (!s.latest.has(digest)) throw new Error("REPLAY_LEDGER_MISSING_RESERVATION");
                const { seq, eventHmac } = await insertEvent({ ...binding, digest }, state, s);
                await dbCall(db, "run", "COMMIT");
                await persistAnchors(seq, eventHmac);
                return true;
            } catch (error) {
                try { await dbCall(db, "run", "ROLLBACK"); } catch { /* already rolled back */ }
                throw error;
            }
        },

        async _lookup(digest) {
            const s = await snapshot();
            return s.latest.get(digest) ?? null;
        },

        filePath: file,
        STATES
    });
}

module.exports = { STATES, createCanonicalReplayLedger };
