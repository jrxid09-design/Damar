"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { LedgerError, CODES } = require("./errors");
const { digestCore } = require("./events");
const { sha256Hex, isValidDigestFormat } = require("./integrity");
const { canonicalJson } = require("./canonicalJson");

/**
 * DURABLE AUDIT LEDGER FILE SINK — append-only JSONL production adapter
 * (Trust Foundation stage, Wave 5 Lane 4).
 *
 * This implements the EXISTING AuditPersistencePort contract
 * (ports.js) for the canonical Audit Ledger — it does NOT replace the
 * ledger and does NOT implement a second log.  It is the narrow durable
 * sink the existing ledger persistence precondition requires.
 *
 * LAW:
 *   - AUDIT LEDGER != AUTHORITY.  This sink persists immutable
 *     observational records only; it grants nothing.
 *
 * DURABILITY MODEL (synchronous, matching the V1 atomic contract):
 *   - append(record) serializes the FROZEN record to ONE canonical JSON
 *     line and fsync-flushes it to the sink file.  The write happens
 *     BEFORE the ledger's in-memory commit, so a failed write rejects the
 *     append atomically (the event is never falsely "durably committed").
 *   - Appends are serialized through an in-process write queue so
 *     overlapping appends cannot interleave or corrupt the line stream.
 *   - Each line is independently self-describing and hash-chained via the
 *     record's own integrity block (sequence + prevDigest + digest).
 *
 * RESTART / CONTINUATION:
 *   - On construction the sink reads the existing file and verifies the
 *     chain (per-record digest + prev-linkage + strictly increasing
 *     sequence).  It exposes describeDurable() returning the observed
 *     tail state ({ records, lastSequence, lastDigest }) so a caller can
 *     continue a ledger across restart.
 *   - A corrupt, truncated, or chain-broken file FAILS CLOSED: the sink
 *     enters an explicit `corrupt` state and REFUSES all further appends
 *     (never silently appending onto a broken chain).  It never silently
 *     resets history.
 *
 * REDACTION / HYGIENE:
 *   - The record is already redacted by the ledger before it reaches the
 *     sink; this sink writes the record verbatim and never logs values.
 *   - No Vault secret/proof/token values are written here (the sink only
 *     ever sees redacted audit events).
 *   - File is created 0o600; writes use atomic line-append with fsync.
 */

const SINK_KIND = "audit-file-jsonl-v1";

function failPersist(message, detail) {
    return new LedgerError(CODES.PERSIST_FAILED, message, detail);
}

function failSink(message) {
    return new LedgerError(CODES.INVALID_EVENT, message);
}

/** Canonical one-line serialization of a frozen audit record. */
function serializeRecordLine(record) {
    // Reuse the ledger's own canonical serializer for byte-determinism.
    return canonicalJson(record, { maxDepth: 32 });
}

/** Parse + validate one stored line back into a record shell. */
function parseRecordLine(line) {
    let record;
    try {
        record = JSON.parse(line);
    } catch {
        throw failSink("stored audit line is not valid JSON");
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw failSink("stored audit line is not an object");
    }
    return record;
}

/** Verify a stored record's self-digest matches its content. */
function verifySelfDigest(record) {
    if (!record.integrity || typeof record.integrity !== "object") {
        throw failSink("stored audit record missing integrity block");
    }
    if (!isValidDigestFormat(record.integrity.digest)) {
        throw failSink("stored audit record digest malformed");
    }
    const expected = sha256Hex(Buffer.from(digestCore(record), "utf8"));
    if (expected !== record.integrity.digest) {
        throw failSink("stored audit record digest mismatch");
    }
}

/**
 * Verify a run of stored records forms a valid chain: strictly increasing
 * sequence, each record's prevDigest equals the previous record's digest,
 * and every self-digest is valid.  Returns the tail state.
 */
function verifyChain(records) {
    let lastSequence = 0;
    let lastDigest = null;
    const seenIds = new Set();
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!Number.isSafeInteger(record.sequence) || record.sequence <= lastSequence) {
            throw failSink("stored audit sequence is not strictly increasing");
        }
        verifySelfDigest(record);
        if (i > 0 && record.integrity.prevDigest !== lastDigest) {
            throw failSink("stored audit chain link mismatch");
        }
        if (seenIds.has(record.eventId)) {
            throw failSink("stored audit duplicate eventId");
        }
        seenIds.add(record.eventId);
        lastSequence = record.sequence;
        lastDigest = record.integrity.digest;
    }
    return { lastSequence, lastDigest, count: records.length };
}

/**
 * createFileAuditSink(filePath, options)
 *
 * @param {string} filePath durable JSONL sink file.
 * @param {object} [options]
 * @param {boolean} [options.fsync=true] fsync after each append (durable).
 */
function createFileAuditSink(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw failSink("audit file sink requires a file path");
    }
    const fsync = options.fsync !== false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // TF-003 SINGLE-WRITER OWNERSHIP: an exclusive lock file guards the
    // canonical sink file so two active sink owners (in this process or
    // cooperating local processes) cannot own the same file and append
    // conflicting tail state.  The lock is acquired atomically
    // (create-exclusive) and is NOT a distributed lock service — it is the
    // narrow local ownership the existing single-process runtime expects.
    // Candidate-tail validation remains mandatory even with ownership.
    const lockPath = `${filePath}.lock`;
    let lockFd = null;
    let lockHeld = false;
    try {
        // "wx" = O_CREAT|O_EXCL|O_WRONLY: fails if the lock already exists.
        lockFd = fs.openSync(lockPath, "wx");
        lockHeld = true;
    } catch (error) {
        if (error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES")) {
            throw new LedgerError(CODES.PERSIST_FAILED,
                "audit sink file is already owned by another active writer");
        }
        throw failPersist(`audit sink lock acquisition failed: ${error.message}`);
    }

    function releaseLock() {
        if (!lockHeld) return;
        lockHeld = false;
        try { if (lockFd !== null) fs.closeSync(lockFd); } catch { /* best-effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    }

    // ---- load + verify existing tail (restart continuation) ----------
    let tail = { lastSequence: 0, lastDigest: null, count: 0 };
    let corrupt = false;
    let corruptReason = null;
    const seenEventIds = new Set();

    if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const records = [];
        try {
            for (const line of lines) {
                records.push(parseRecordLine(line));
            }
            tail = verifyChain(records);
            for (const record of records) seenEventIds.add(record.eventId);
        } catch (error) {
            // FAIL CLOSED: corrupt/truncated/chain-broken history.  Enter an
            // explicit recovery state; refuse all further appends; never
            // silently append onto a broken chain and never silently reset.
            corrupt = true;
            corruptReason = error instanceof LedgerError ? error.message : "stored audit history failed verification";
        }
    }

    // In-process write queue: appends never interleave mid-line.
    let writing = false;
    const queue = [];

    function appendLine(line) {
        // Atomic append of one fsync'd line.  O_EX so two sinks cannot both
        // create the file; the queue guarantees single-writer ordering here.
        const fd = fs.openSync(filePath, "a");
        try {
            fs.writeSync(fd, line + "\n");
            if (fsync) fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    function drain() {
        if (writing) return;
        writing = true;
        try {
            while (queue.length > 0) {
                const line = queue.shift();
                appendLine(line);
            }
        } finally {
            writing = false;
        }
    }

    const sink = {
        /**
         * Persist one frozen audit record.  Synchronous; throws
         * LedgerError(PERSIST_FAILED) on any failure so the ledger rejects
         * the append atomically (no false durable success).
         *
         * TF-001 CANDIDATE-TAIL VALIDATION: even with single-writer
         * ownership, every candidate is validated against the CURRENT
         * durable tail — sequence must be exactly tail+1 and prevDigest
         * must equal the durable last digest.  Skipped/duplicate sequence,
         * wrong prevDigest, and wrong self-digest are all rejected.
         */
        append(record) {
            if (corrupt) {
                throw failPersist(
                    `audit sink is in a corrupt recovery state and refuses appends: ${corruptReason}`);
            }
            if (record === null || typeof record !== "object" || Array.isArray(record)) {
                throw failPersist("audit record must be an object");
            }
            if (typeof record.eventId !== "string" || record.eventId.length === 0) {
                throw failPersist("audit record missing eventId");
            }
            if (seenEventIds.has(record.eventId)) {
                throw failPersist("duplicate eventId in durable audit sink");
            }
            // ---- candidate-tail validation (TF-001) --------------------
            if (!Number.isSafeInteger(record.sequence)) {
                throw failPersist("audit record sequence must be an integer");
            }
            if (record.sequence !== tail.lastSequence + 1) {
                throw failPersist(
                    `audit sequence must continue the durable tail exactly ` +
                    `(expected ${tail.lastSequence + 1}, got ${record.sequence})`);
            }
            const prevDigest = record.integrity && record.integrity.prevDigest !== undefined
                ? record.integrity.prevDigest
                : undefined;
            if (prevDigest !== tail.lastDigest) {
                throw failPersist("audit prevDigest does not match the durable tail digest");
            }
            // The record's own self-digest must be valid for its content.
            try {
                verifySelfDigest(record);
            } catch (error) {
                throw failPersist(`audit record failed integrity validation: ${error.message}`);
            }
            let line;
            try {
                line = serializeRecordLine(record);
            } catch (error) {
                throw failPersist(`audit record failed canonical serialization: ${error.message}`);
            }
            try {
                queue.push(line);
                drain();
            } catch (error) {
                throw failPersist(`audit sink write failed: ${error.message}`);
            }
            seenEventIds.add(record.eventId);
            tail = {
                lastSequence: record.sequence,
                lastDigest: record.integrity && typeof record.integrity.digest === "string"
                    ? record.integrity.digest
                    : tail.lastDigest,
                count: tail.count + 1
            };
            return true;
        },

        /** Observed durable tail state for restart continuation. */
        describeDurable() {
            return Object.freeze({
                kind: SINK_KIND,
                corrupt,
                corruptReason,
                records: tail.count,
                lastSequence: tail.lastSequence,
                lastDigest: tail.lastDigest,
                fsync
            });
        },

        /**
         * Verified resume seed for the canonical ledger (TF-001).  The sink
         * holds no sequence authority — it only reports verified durable
         * tail state; the canonical createAuditLedger resumes from it.
         */
        verifiedTail() {
            if (corrupt) {
                throw failPersist(
                    `cannot resume from a corrupt audit sink: ${corruptReason}`);
            }
            return Object.freeze({
                lastSequence: tail.lastSequence,
                lastDigest: tail.lastDigest
            });
        },

        /** Read back the verified stored records (bounded, for continuation/tests). */
        readAll() {
            if (!fs.existsSync(filePath)) return Object.freeze([]);
            const raw = fs.readFileSync(filePath, "utf8");
            const lines = raw.split("\n").filter((l) => l.trim().length > 0);
            return Object.freeze(lines.map((l) => parseRecordLine(l)));
        },

        /** Release the single-writer lock (TF-003).  Idempotent. */
        close() {
            releaseLock();
        }
    };

    return Object.freeze(sink);
}

module.exports = Object.freeze({
    createFileAuditSink,
    SINK_KIND
});
