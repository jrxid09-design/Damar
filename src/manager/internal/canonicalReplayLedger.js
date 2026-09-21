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
        try {
            // Same short-write discipline: a truncated key must never be trusted.
            let written = 0;
            while (written < key.length) {
                const n = fs.writeSync(fd, key, written, key.length - written);
                if (!Number.isInteger(n) || n <= 0) throw new Error("REPLAY_INTEGRITY_KEY_SHORT_WRITE");
                written += n;
            }
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
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

let ANCHOR_TEMP_SEQ = 0;

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Bounded retry for the transient rename-collision codes Windows can raise when
 *  two processes rename onto the same target concurrently. */
async function renameWithRetry(temp, destination) {
    for (let attempt = 0; ; attempt++) {
        try {
            return fs.renameSync(temp, destination);
        } catch (error) {
            const code = error && error.code;
            if (attempt < 6 && TRANSIENT_RENAME_CODES.has(code)) {
                await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
}

async function writeTrustedAnchor(anchorFile, seq, eventHmac, key) {
    const anchorHmac = hmac(key, String(seq) + ":" + eventHmac);
    const payload = JSON.stringify({ seq, eventHmac, anchorHmac });

    // NON-DESTRUCTIVE WRITE (every platform): stage the full payload in a temp
    // file, fsync it, THEN atomically replace the live anchor. The live file is
    // never truncated before the new payload is durable, so a mid-write I/O
    // failure leaves the PREVIOUS valid anchor intact and recoverable via
    // snapshot()'s BEHIND reconciliation. The win32 rename-durability caveat is
    // unchanged (Node sets no MOVEFILE_WRITE_THROUGH); readers still get atomic
    // replacement. The temp name is UNIQUE PER WRITER so concurrent self-heal
    // writers cannot collide on one temp inode and throw raw ENOENT/EPERM.
    ANCHOR_TEMP_SEQ = (ANCHOR_TEMP_SEQ + 1) >>> 0;
    const temp = `${anchorFile}.tmp.${process.pid}.${ANCHOR_TEMP_SEQ}`;
    let fd = null;
    try {
        fd = fs.openSync(temp, "w", 0o600);
        const buf = Buffer.from(payload, "utf8");
        let written = 0;
        while (written < buf.length) {
            const n = fs.writeSync(fd, buf, written, buf.length - written);
            // Reject non-integer, non-positive AND over-reported counts. An
            // inflated count would skip remaining bytes and promote a truncated
            // payload over the live anchor (silent permanent corruption).
            if (!Number.isInteger(n) || n <= 0 || n > buf.length - written) {
                throw new Error("REPLAY_ANCHOR_SHORT_WRITE");
            }
            written += n;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        await renameWithRetry(temp, anchorFile);
        syncDirectory(path.dirname(anchorFile));
    } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
        try { fs.unlinkSync(temp); } catch { /* already gone */ }
        throw error;
    }
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
    async function doOpen() {
        // busy_timeout FIRST so the remaining statements run under a real
        // timeout. The WAL-mode transition on a BRAND-NEW file can still raise
        // SQLITE_BUSY under N-way simultaneous first opens (busy_timeout does
        // not cover that schema change), so the whole sequence is retried.
        for (let attempt = 0; ; attempt++) {
            try {
                await dbCall(db, "run", "PRAGMA busy_timeout=10000");
                await dbCall(db, "run", "PRAGMA journal_mode=WAL");
                await dbCall(db, "run", "PRAGMA synchronous=FULL");
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL,state TEXT NOT NULL,capability_id TEXT,operation TEXT,principal TEXT,scope TEXT,authority_generation INTEGER,driver_id TEXT,at_ms INTEGER NOT NULL,prev_hmac TEXT NOT NULL,event_hmac TEXT NOT NULL)");
        await dbCall(db, "run", "CREATE INDEX IF NOT EXISTS idx_replay_digest ON replay_events(digest)");
        // P0-1: replay_current is no longer a trusted source. Drop any legacy
        // table so no unauthenticated cache can ever influence execution.
                // Committed-but-UNACKNOWLEDGED heads. Written in the SAME transaction as
        // the event, so a crash after COMMIT but before any witness advances is
        // an explicit, durable recovery state rather than a silent success. This
        // is NOT a replay-authority cache: it can only ever force refusal.
        await dbCall(db, "run", "CREATE TABLE IF NOT EXISTS replay_unwitnessed(seq INTEGER PRIMARY KEY,event_hmac TEXT NOT NULL,at_ms INTEGER NOT NULL)");
        await dbCall(db, "run", "DROP TABLE IF EXISTS replay_current");
                return;
            } catch (error) {
                const text = String((error && error.code) || "") + " " + String((error && error.message) || "");
                if (attempt < 8 && text.includes("SQLITE_BUSY")) {
                    await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
                    continue;
                }
                throw error;
            }
        }
    }
    const open = () => {
        if (ready === null) ready = doOpen().catch((error) => { ready = null; throw error; });
        return ready;
    };

    async function snapshot({ heal = true } = {}) {
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

            // DURABLE UNACKNOWLEDGED HEAD. A committed head is only safe once a
            // TRUSTED witness has durably advanced past it. If a higher head was
            // ever committed, truncating replay_events below it is DETECTED here
            // even when every anchor still agrees with the truncated DB.
            const pending = await new Promise((resolve, reject) =>
                db.all("SELECT seq FROM replay_unwitnessed ORDER BY seq", [], (e, r) => (e ? reject(e) : resolve(r))));
            if (pending.length) {
                const highest = pending[pending.length - 1].seq;
                if (highest > rows.length) throw new Error("REPLAY_TRUNCATION_DETECTED");
                // History is intact but the head is unacknowledged. A read is still
                // valid (the rows are HMAC-authenticated); only a writer reconciles,
                // and only with independent witness advancement.
                if (heal) {
                    const status = await persistAnchors(rows.length, previous);
                    if (!status.witnessOk) throw new Error("REPLAY_HEAD_UNWITNESSED: " + describePersistence(status));
                    await markWitnessed(rows.length);
                }
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
                if (anchor && anchor.seq !== 0) {
                    // A stale-empty read straddling a writer's FIRST commit +
                    // anchor-persist is the same benign timing as the non-empty
                    // case, so it retries identically; real tamper exhausts retries.
                    if (attempt < 3) { await new Promise((r) => setTimeout(r, 2)); continue; }
                    throw new Error("REPLAY_ANCHOR_MISMATCH");
                }
            } else if (!anchor) {
                // A committed row exists but the anchor has not been persisted yet:
                // the anchor is written AFTER COMMIT, so a concurrent reader can
                // observe this benign window (e.g. the loser of a cross-process
                // race). Retry bounded; a genuinely missing anchor still fails closed.
                if (attempt < 3) { await new Promise((r) => setTimeout(r, 2)); continue; }
                throw new Error("REPLAY_ANCHOR_MISMATCH");
            } else if (anchor.seq > rows.length) {
                if (attempt < 3) { await new Promise((r) => setTimeout(r, 2)); continue; }
                throw new Error("REPLAY_ANCHOR_MISMATCH");
            } else if (anchor.seq < rows.length) {
                const prefixHmac = anchor.seq >= 1 ? rows[anchor.seq - 1].event_hmac : null;
                if (prefixHmac === null || prefixHmac !== anchor.eventHmac) throw new Error("REPLAY_ANCHOR_MISMATCH");
                // Read-only callers (lookup) must not write: healing happens only
                // on the writer path, never from an unlocked read.
                // Healing is BEST-EFFORT: a BEHIND anchor is already benign (the
                // rows are authenticated), so a failed heal must never block
                // unrelated reservations with a raw fs error.
                if (heal) {
                    try { await writeTrustedAnchor(anchorFile, rows.length, previous, key); }
                    catch { /* best-effort; the next writer retries */ }
                }
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
                    // A genuine external anchor cannot be behind, so "behind" only
                    // means our own commit failed. Only the writer path advances it;
                    // a read-only caller must not throw on this benign state.
                    if (heal) {
                        try { rollbackAnchor.commit(rows.length, previous); }
                        catch { throw new Error("REPLAY_ROLLBACK_ANCHOR_UNAVAILABLE"); }
                    }
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

        // Same transaction as the event: either both land or neither does.
        await dbCall(db, "run", "INSERT OR REPLACE INTO replay_unwitnessed(seq,event_hmac,at_ms) VALUES(?,?,?)",
            [seq, eventHmac, atMs]);

        return { seq, eventHmac };
    }

    /** Attempt BOTH witnesses INDEPENDENTLY and REPORT the outcome; the caller
     *  decides, because the trust model differs. When an EXTERNAL anchor is
     *  configured it is the only rollback-resistant witness and the local,
     *  co-located anchor MUST NOT substitute for it. Both diagnostics are always
     *  preserved so operators can distinguish external / local / both failures. */
    function describePersistence(status) {
        const parts = [
            "external=" + (status.externalOk === null ? "not-configured" : (status.externalOk ? "ok" : "FAILED(" + String(status.externalError && status.externalError.message) + ")")),
            "local=" + (status.localOk ? "ok" : "FAILED(" + String(status.localError && status.localError.message) + ")")
        ];
        return parts.join("; ");
    }

    async function persistAnchors(seq, eventHmac) {
        let externalError = null;
        if (rollbackAnchor) {
            try { rollbackAnchor.commit(seq, eventHmac); }
            catch (error) { externalError = error; }
        }
        let localError = null;
        try { await writeTrustedAnchor(anchorFile, seq, eventHmac, key); }
        catch (error) { localError = error; }

        const externalOk = rollbackAnchor ? externalError === null : null;
        const localOk = localError === null;
        return {
            externalOk,
            localOk,
            witnessOk: rollbackAnchor ? externalOk === true : localOk === true,
            externalError,
            localError
        };
    }

    /** Remove a committed-but-UNWITNESSED tail so the durable store never retains an
     *  event that no trusted witness covers. Without this, an attacker who can
     *  truncate replay_events can also delete the co-located marker row, leaving a
     *  fully self-consistent frozen store (the audit of 2de4e8e). After this the
     *  unacknowledged append simply did not happen, so nothing is resurrectable.
     *  Safe: it only removes the exact tail seq, and only while it is still the
     *  tail; anything else is left for fail-closed recovery. */
    async function compensate(seq) {
        try {
            await dbCall(db, "run", "BEGIN IMMEDIATE");
            const tail = await new Promise((resolve, reject) =>
                db.get("SELECT MAX(seq) AS maxSeq FROM replay_events", [], (e, r) => (e ? reject(e) : resolve(r))));
            if (tail && tail.maxSeq === seq) {
                await dbCall(db, "run", "DELETE FROM replay_events WHERE seq = ?", [seq]);
                await dbCall(db, "run", "DELETE FROM replay_unwitnessed WHERE seq = ?", [seq]);
            }
            await dbCall(db, "run", "COMMIT");
        } catch { /* leave the marker: recovery stays fail-closed */ }
    }

    /** Clear the durable marker only once a trusted witness has advanced. */
    async function markWitnessed(seq) {
        try { await dbCall(db, "run", "DELETE FROM replay_unwitnessed WHERE seq <= ?", [seq]); }
        catch { /* best-effort; snapshot() reconciles on the next call */ }
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
                // DB COMMIT != SAFE COMPLETION. The committed head is acknowledged
                // only once a TRUSTED witness has durably advanced to it. If none
                // has, fail closed: the durable marker keeps this fail-closed
                // across restart so a later truncation to the frozen anchor point
                // is still detected and this digest is NOT re-executable.
                const persistence = await persistAnchors(seq, eventHmac);
                if (!persistence.witnessOk) {
                    // No trusted witness advanced: undo the append entirely so the
                    // store cannot later look self-consistent with a frozen head.
                    await compensate(seq);
                    throw new Error("REPLAY_HEAD_UNWITNESSED: " + describePersistence(persistence));
                }
                await markWitnessed(seq);
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
                const persistence = await persistAnchors(seq, eventHmac);
                if (!persistence.witnessOk) {
                    // Undo the append: the digest reverts to its PREVIOUS state, so
                    // an effect that already ran stays INVOKING (ambiguous) and can
                    // never be silently re-driven.
                    await compensate(seq);
                    throw new Error("REPLAY_HEAD_UNWITNESSED: " + describePersistence(persistence));
                }
                await markWitnessed(seq);
                return true;
            } catch (error) {
                try { await dbCall(db, "run", "ROLLBACK"); } catch { /* already rolled back */ }
                throw error;
            }
        },

        async _lookup(digest) {
            const s = await snapshot({ heal: false });
            return s.latest.get(digest) ?? null;
        },

        filePath: file,
        STATES
    });
}

module.exports = { STATES, createCanonicalReplayLedger };
