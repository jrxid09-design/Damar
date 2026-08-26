"use strict";

const crypto = require("node:crypto");
const { LedgerError, CODES } = require("./errors");
const { resolveBounds } = require("./config");
const { newAuditEventId } = require("./ids");
const { CORRELATION_KEYS } = require("./ids");
const { buildEventRecord, digestCore, RESERVED_EVENT_TYPES } = require("./events");
const { canonicalJson } = require("./canonicalJson");
const { sha256Hex } = require("./integrity");

/**
 * Audit Ledger V1 — the append-oriented observational ledger.
 *
 * LAWS (binding):
 *  - Observational only. The ledger NEVER issues grants, delegates,
 *    ratifies, revokes, authorizes, consumes budgets, executes tools,
 *    actuates devices, touches shell/network/Console, or replays
 *    history as commands. There is no code path here that could.
 *  - Append-only in spirit: stored records are never rewritten.
 *    Corrections/supersessions are NEW events that reference their
 *    target by eventId; the target stays untouched.
 *  - Atomic failure: an invalid event mutates NOTHING. Duplicate
 *    eventIds are rejected before any state change.
 *  - Ordering is by monotonic `sequence` (per ledger instance), never
 *    by timestamp alone. Timestamps are observations of wall time.
 *  - Readers get deep copies of frozen records; no internal reference
 *    ever escapes, so callers cannot mutate stored history.
 *  - Bounded memory: retention window evicts oldest records while the
 *    logical sequence keeps advancing.
 *
 * Durability: V1 ships a persistence PORT (`sink`) plus this
 * deterministic in-memory implementation. A production durable adapter
 * (e.g. SQLite with transactional appends + unique(event_id)) is a
 * documented requirement for deployment; see docs/architecture/
 * audit-ledger-v1.md. With { durable:true }, the sink is written
 * BEFORE the in-memory commit so a persist failure leaves the ledger
 * completely unmutated (atomic).
 */

function defaultClock() {
    return Date.now();
}

function defaultIdFactory() {
    return newAuditEventId();
}

/** Deep-freeze a plain structure (records contain only plain data). */
function deepFreeze(value) {
    if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
        Object.freeze(value);
    }
    return value;
}

/** Detached deep copy: readers never receive internal references. */
function detach(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(detach);
    const out = {};
    for (const key of Object.keys(value)) out[key] = detach(value[key]);
    return out;
}

function createAuditLedger(options = {}) {
    const bounds = resolveBounds(options.bounds);
    const clock = typeof options.clock === "function" ? options.clock : defaultClock;
    const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
    const sink = options.sink === undefined || options.sink === null
        ? null
        : assertSink(options.sink);

    /** Retention window: newest records, bounded length. */
    const records = [];
    /** eventId -> record index map kept in sync with eviction. */
    const indexById = new Map();

    let sequenceCounter = 0;
    let lastDigest = null;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let evictedCount = 0;

    function assertSink(candidate) {
        if (typeof candidate !== "object" || candidate === null ||
            typeof candidate.append !== "function") {
            throw new LedgerError(CODES.NO_SINK,
                "sink must expose append(record) (persistence port)");
        }
        return candidate;
    }

    /**
     * Commit a fully validated input. Throws LedgerError BEFORE any
     * mutation on invalid input (atomic). Returns the frozen record.
     *
     * B3 ATOMICITY: the next sequence value is COMPUTED
     * (sequenceCounter + 1) but sequenceCounter is only advanced in the
     * final commit phase, after normalization, canonical serialization,
     * digest generation, and the durable persistence precondition have
     * ALL succeeded. Rejected appends therefore never burn sequence
     * numbers, and canonical state (sequence, lastDigest, records,
     * indexes) is byte-identical before/after any rejection.
     */
    function commit(input, { durable = false } = {}) {
        // ---- validation phase: zero mutation -------------------------
        const shell = buildEventRecord(input, bounds);

        if (shell.eventId === null) shell.eventId = idFactory();
        if (indexById.has(shell.eventId)) {
            throw new LedgerError(CODES.DUPLICATE_EVENT_ID,
                `eventId already recorded: ${shell.eventId}`);
        }
        if (shell.timestampMs === null) shell.timestampMs = clock();

        const nextSequence = sequenceCounter + 1;
        shell.sequence = nextSequence;

        // Hash chain over canonical serialization (corruption detection
        // ONLY — see integrity.js for binding semantics disclaimer).
        shell.integrity = Object.freeze({
            algorithm: "sha256",
            prevDigest: lastDigest,
            digest: sha256Hex(Buffer.from(digestCore(shell), "utf8"))
        });

        // Freeze before the durability phase: the sink observes exactly
        // what would be committed, and a frozen candidate can never be
        // partially applied if persistence rejects.
        const record = deepFreeze(shell);

        // ---- durability phase (optional): still zero mutation --------
        if (durable) {
            if (!sink) {
                throw new LedgerError(CODES.NO_SINK,
                    "durable append requested but no persistence sink configured");
            }
            try {
                const outcome = sink.append(record);
                if (outcome && typeof outcome.then === "function") {
                    throw new LedgerError(CODES.PERSIST_FAILED,
                        "async sinks are not supported by atomic durable append in V1");
                }
            }
            catch (error) {
                if (error instanceof LedgerError) throw error;
                throw new LedgerError(CODES.PERSIST_FAILED,
                    `persistence sink rejected append: ${error.message}`);
            }
        }

        // ---- commit phase: single atomic advance ---------------------
        sequenceCounter = nextSequence;
        lastDigest = record.integrity.digest;

        records.push(record);
        indexById.set(record.eventId, record);
        while (records.length > bounds.maxInMemoryEvents) {
            const evicted = records.shift();
            indexById.delete(evicted.eventId);
            evictedCount += 1;
        }
        acceptedCount += 1;

        return record;
    }

    /**
     * Append an event. Throws on invalid input (callers that must never
     * crash execution should use appendSafe). Never mutates existing
     * history; returns the frozen stored record.
     */
    function append(input, opts) {
        try {
            return commit(input, opts);
        }
        catch (error) {
            rejectedCount += 1;
            throw error;
        }
    }

    /**
     * Never-throwing variant: converts validation/persistence failures
     * into { ok:false, error:{ code, message } }. Audit failure must not
     * take down the operation being observed.
     */
    function appendSafe(input, opts) {
        try {
            return { ok: true, event: detach(append(input, opts)) };
        }
        catch (error) {
            return {
                ok: false,
                error: {
                    code: error instanceof LedgerError ? error.code : "E_INTERNAL",
                    message: String(error.message ?? error)
                }
            };
        }
    }

    /**
     * Append a correction referencing an earlier event. The corrected
     * record is NOT modified — correction semantics are carried entirely
     * by the new event (targetEventId + reason + optional metadata).
     */
    function correct(targetEventId, { reason, metadata, actor } = {}) {
        const target = getByEventId(targetEventId);
        if (!target) {
            throw new LedgerError(CODES.NOT_APPENDABLE,
                `correction target not found: ${String(targetEventId)}`);
        }
        // Only defined fields enter the input: the snapshot boundary
        // rejects undefined values fail-closed.
        const input = {
            eventType: RESERVED_EVENT_TYPES.CORRECTION,
            source: "audit.ledger",
            causalParentId: target.eventId,
            metadata: {
                targetEventId: target.eventId,
                reason: typeof reason === "string" ? reason.slice(0, bounds.maxMetadataStringLength) : null,
                ...(metadata && typeof metadata === "object" ? metadata : {})
            }
        };
        if (actor !== undefined && actor !== null) input.subject = actor;
        return commit(input);
    }

    /**
     * Append a supersession marking an earlier event as superseded.
     * Again: the old event remains exactly as it was.
     */
    function supersede(targetEventId, { reason, replacementEventId, actor } = {}) {
        const target = getByEventId(targetEventId);
        if (!target) {
            throw new LedgerError(CODES.NOT_APPENDABLE,
                `supersede target not found: ${String(targetEventId)}`);
        }
        const input = {
            eventType: RESERVED_EVENT_TYPES.SUPERSESSION,
            source: "audit.ledger",
            causalParentId: target.eventId,
            metadata: {
                targetEventId: target.eventId,
                replacementEventId:
                    typeof replacementEventId === "string" ? replacementEventId.slice(0, 64) : null,
                reason: typeof reason === "string" ? reason.slice(0, bounds.maxMetadataStringLength) : null
            }
        };
        if (actor !== undefined && actor !== null) input.subject = actor;
        return commit(input);
    }

    // ------------------------------------------------------------------
    // Bounded, deterministic, copy-returning queries.
    // No caller-supplied executable predicates are ever evaluated.
    // ------------------------------------------------------------------

    function clampLimit(limit) {
        if (limit === undefined || limit === null) return bounds.defaultQueryLimit;
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new LedgerError(CODES.INVALID_QUERY, "limit must be a positive integer");
        }
        return Math.min(limit, bounds.maxQueryLimit);
    }

    function orderedWindow({ order = "asc", limit }) {
        const capped = clampLimit(limit);
        const src = order === "desc"
            ? [...records].reverse()
            : records;
        return src.slice(0, capped);
    }

    /** @returns {object|null} detached copy or null */
    function getByEventId(eventId) {
        const record = indexById.get(eventId);
        return record ? detach(record) : null;
    }

    function list(filter = {}, { limit, order = "asc" } = {}) {
        if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
            throw new LedgerError(CODES.INVALID_QUERY, "filter must be an object");
        }
        const corr = filter.correlation;
        if (corr !== undefined && corr !== null) {
            if (typeof corr !== "object" || Array.isArray(corr)) {
                throw new LedgerError(CODES.INVALID_QUERY, "correlation filter must be an object");
            }
            for (const key of Object.keys(corr)) {
                if (!CORRELATION_KEYS.includes(key)) {
                    throw new LedgerError(CODES.INVALID_QUERY, `unknown correlation filter key: ${key}`);
                }
            }
        }
        const capped = clampLimit(limit);
        const out = [];
        const src = order === "desc" ? [...records].reverse() : records;
        for (const record of src) {
            if (out.length >= capped) break;
            if (matches(record, filter)) out.push(detach(record));
        }
        return out;
    }

    function matches(record, filter) {
        for (const [key, value] of Object.entries(filter)) {
            if (value === undefined || value === null) continue;
            switch (key) {
                case "types":
                    if (!Array.isArray(value) || !value.includes(record.eventType)) return false;
                    break;
                case "source":
                    if (record.source !== value) return false;
                    break;
                case "actorKind":
                    if (!record.actor || record.actor.kind !== value) return false;
                    break;
                case "actorId":
                    if (!record.actor || record.actor.id !== value) return false;
                    break;
                case "subjectKind":
                    if (!record.subject || record.subject.kind !== value) return false;
                    break;
                case "subjectId":
                    if (!record.subject || record.subject.id !== value) return false;
                    break;
                case "generation":
                    if (record.generation !== value) return false;
                    break;
                case "outcome":
                    if (record.outcome !== value) return false;
                    break;
                case "causalParentId":
                    if (record.causalParentId !== value) return false;
                    break;
                case "fromMs":
                    if (!(typeof value === "number" && record.timestampMs >= value)) return false;
                    break;
                case "toMs":
                    if (!(typeof value === "number" && record.timestampMs <= value)) return false;
                    break;
                case "correlation": {
                    if (!record.correlation) return false;
                    const corr = filter.correlation;
                    if (!corr || typeof corr !== "object") return false;
                    for (const [ckey, cval] of Object.entries(corr)) {
                        if (cval === undefined || cval === null) continue;
                        if (record.correlation[ckey] !== cval) return false;
                    }
                    break;
                }
                case "metadata.targetEventId":
                    if (!record.metadata || record.metadata.targetEventId !== value) return false;
                    break;
                default:
                    throw new LedgerError(CODES.INVALID_QUERY, `unknown query filter: ${key}`);
            }
        }
        return true;
    }

    /** Count of records currently retained in memory. */
    function size() {
        return records.length;
    }

    /** Operational stats (bounded view). */
    function stats() {
        return Object.freeze({
            retainedEvents: records.length,
            logicalSequence: sequenceCounter,
            acceptedCount,
            rejectedCount,
            evictedCount,
            bounds,
            chainHead: lastDigest,
            hasPersistenceSink: Boolean(sink)
        });
    }

    /**
     * Verify the retained hash-chain window. Returns first inconsistency
     * found, or { ok:true }. NOTE: after eviction the chain head-link at
     * the window boundary cannot be re-derived from memory alone; the
     * check therefore verifies (a) each record's self-digest and
     * (b) prev-linkage WITHIN the retained window.
     */
    function verifyIntegrity({ limit = bounds.maxQueryLimit } = {}) {
        const capped = clampLimit(limit);
        const startIdx = Math.max(0, records.length - capped);
        let prevDigestExpected = null;
        for (let i = startIdx; i < records.length; i++) {
            const record = records[i];
            const expected = sha256Hex(Buffer.from(digestCore(record), "utf8"));
            if (expected !== record.integrity.digest) {
                return { ok: false, brokenAtSequence: record.sequence, reason: "digest mismatch" };
            }
            // The FIRST record of the window may link to an evicted
            // predecessor whose digest memory can no longer supply;
            // linkage is verified strictly WITHIN the window.
            if (i > startIdx && record.integrity.prevDigest !== prevDigestExpected) {
                return { ok: false, brokenAtSequence: record.sequence, reason: "chain link mismatch" };
            }
            prevDigestExpected = record.integrity.digest;
        }
        return { ok: true, checked: records.length - startIdx };
    }

    /**
     * Deterministic export of the retained window (bounded, copies).
     * Intended for a future durable adapter's bulk load, not for replay.
     */
    function exportWindow({ limit } = {}) {
        return orderedWindow({ order: "asc", limit }).map(detach);
    }

    return Object.freeze({
        append,
        appendSafe,
        correct,
        supersede,
        getByEventId,
        list,
        size,
        stats,
        verifyIntegrity,
        exportWindow,
        bounds
    });
}

module.exports = Object.freeze({ createAuditLedger, detach, deepFreeze });
