"use strict";

const {
    newAuditEventId,
    coerceAuditEventId,
    coerceSourceId,
    coerceGenerationRef,
    coerceCorrelation,
    isRefValue
} = require("./ids");
const { LedgerError, CODES } = require("./errors");
const { canonicalJson } = require("./canonicalJson");
const { sanitizeMetadata } = require("./redact");

/**
 * Audit Ledger V1 — event model.
 *
 * An AuditEvent is an OBSERVATION of something that happened. It is:
 *   - not Authority (a recorded grant reference is not a grant),
 *   - not current truth (a recorded state is historical),
 *   - not executable (no callbacks/functions can enter an event),
 *   - immutable once appended (deep-frozen; readers get copies).
 *
 * Only eventType and source are required. Every other field is optional;
 * "do not require every field on every event" is a hard rule.
 */

const OUTCOMES = Object.freeze([
    "ok",
    "denied",
    "error",
    "timeout",
    "partial",
    "unspecified"
]);

const ACTOR_KINDS = Object.freeze([
    "system", "agent", "user", "device", "extension", "service", "external"
]);

const EVIDENCE_KINDS = Object.freeze([
    "toolResult", "envelope", "checkpoint", "manifest",
    "digest", "document", "external"
]);

const AUTHORITY_REF_KINDS = Object.freeze([
    "grant", "ratification", "proposal", "delegation", "decision", "capability"
]);

/** Reserved ledger-level event types (correction/supersession flow). */
const RESERVED_EVENT_TYPES = Object.freeze({
    CORRECTION: "ledger.correction",
    SUPERSESSION: "ledger.supersession"
});

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){0,5}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertPlainObject(value, label) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new LedgerError(CODES.INVALID_EVENT, `${label} must be an object`);
    }
    return value;
}

function coerceActorSubject(input, label) {
    const obj = assertPlainObject(input, label);
    if (obj === undefined) return undefined;
    for (const key of Object.keys(obj)) {
        if (key !== "kind" && key !== "id") {
            throw new LedgerError(CODES.INVALID_EVENT, `unknown ${label} field: ${key}`);
        }
    }
    if (!ACTOR_KINDS.includes(obj.kind)) {
        throw new LedgerError(CODES.INVALID_EVENT, `${label}.kind invalid`);
    }
    if (!isRefValue(obj.id)) {
        throw new LedgerError(CODES.MALFORMED_REF, `${label}.id malformed`);
    }
    return Object.freeze({ kind: obj.kind, id: obj.id });
}

function coerceEvidenceRefs(input, bounds) {
    if (input === undefined || input === null) return undefined;
    if (!Array.isArray(input)) {
        throw new LedgerError(CODES.INVALID_EVENT, "evidenceRefs must be an array");
    }
    if (input.length > bounds.maxEvidenceRefs) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `more than ${bounds.maxEvidenceRefs} evidenceRefs`);
    }
    const out = input.map((raw) => {
        const obj = assertPlainObject(raw, "evidenceRef");
        if (obj === undefined) {
            throw new LedgerError(CODES.MALFORMED_REF, "evidenceRef must be an object");
        }
        for (const key of Object.keys(obj)) {
            if (!["kind", "id", "digest"].includes(key)) {
                throw new LedgerError(CODES.MALFORMED_REF, `unknown evidenceRef field: ${key}`);
            }
        }
        if (!EVIDENCE_KINDS.includes(obj.kind)) {
            throw new LedgerError(CODES.MALFORMED_REF, "evidenceRef.kind invalid");
        }
        if (!isRefValue(obj.id)) {
            throw new LedgerError(CODES.MALFORMED_REF, "evidenceRef.id malformed");
        }
        const ref = { kind: obj.kind, id: obj.id };
        if (obj.digest !== undefined && obj.digest !== null) {
            if (typeof obj.digest !== "string" || !SHA256_PATTERN.test(obj.digest)) {
                throw new LedgerError(CODES.MALFORMED_REF, "evidenceRef.digest malformed");
            }
            ref.digest = obj.digest;
        }
        return Object.freeze(ref);
    });
    return out.length > 0 ? Object.freeze(out) : undefined;
}

/**
 * An authority reference points at authority identity. It grants
 * NOTHING. Kind+id(+optional digest of the referenced artifact) only.
 */
function coerceAuthorityRef(input) {
    const obj = assertPlainObject(input, "authorityRef");
    if (obj === undefined) return undefined;
    for (const key of Object.keys(obj)) {
        if (!["kind", "id", "digest"].includes(key)) {
            throw new LedgerError(CODES.INVALID_EVENT, `unknown authorityRef field: ${key}`);
        }
    }
    if (!AUTHORITY_REF_KINDS.includes(obj.kind)) {
        throw new LedgerError(CODES.INVALID_EVENT, "authorityRef.kind invalid");
    }
    if (!isRefValue(obj.id)) {
        throw new LedgerError(CODES.MALFORMED_REF, "authorityRef.id malformed");
    }
    const ref = { kind: obj.kind, id: obj.id };
    if (obj.digest !== undefined && obj.digest !== null) {
        if (typeof obj.digest !== "string" || !SHA256_PATTERN.test(obj.digest)) {
            throw new LedgerError(CODES.MALFORMED_REF, "authorityRef.digest malformed");
        }
        ref.digest = obj.digest;
    }
    return Object.freeze(ref);
}

function coerceOperation(operation) {
    if (operation === undefined || operation === null) return undefined;
    if (typeof operation !== "string" || operation.length === 0 || operation.length > 128 ||
        /[^\x20-\x7E]/.test(operation)) {
        throw new LedgerError(CODES.INVALID_EVENT, "operation malformed");
    }
    return operation;
}

function coerceEventType(eventType, bounds) {
    if (typeof eventType !== "string" ||
        eventType.length === 0 ||
        eventType.length > bounds.maxEventTypeLength ||
        !EVENT_TYPE_PATTERN.test(eventType)) {
        throw new LedgerError(CODES.INVALID_EVENT, "eventType malformed");
    }
    return eventType;
}

function coerceTimestamp(timestampMs) {
    if (timestampMs === undefined || timestampMs === null) return undefined;
    if (typeof timestampMs !== "number" || !Number.isSafeInteger(timestampMs) ||
        timestampMs < 0 || timestampMs > 8.64e15) {
        throw new LedgerError(CODES.INVALID_EVENT, "timestampMs invalid");
    }
    return timestampMs;
}

/**
 * Fields allowed on an append request. Unknown keys are rejected
 * fail-closed so forged or future fields cannot smuggle through.
 */
const ALLOWED_INPUT_KEYS = Object.freeze([
    "eventId", "eventType", "timestampMs", "source",
    "actor", "subject", "operation", "outcome",
    "generation", "correlation",
    "evidenceRefs", "authorityRef", "causalParentId",
    "metadata"
]);

/**
 * Validate + normalize one append request into a frozen record shell.
 * Sequence/integrity fields are attached by the ledger, not here.
 *
 * @returns {object} frozen partial record (without sequence/integrity)
 */
function buildEventRecord(input, bounds) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new LedgerError(CODES.NOT_APPENDABLE, "event input must be an object");
    }

    // Reject non-own/injected keys as well as unknown ones.
    const keys = Object.keys(input);
    for (const key of keys) {
        if (!ALLOWED_INPUT_KEYS.includes(key)) {
            throw new LedgerError(CODES.INVALID_EVENT, `unknown event field: ${key}`);
        }
    }

    let eventId;
    if (input.eventId !== undefined && input.eventId !== null) {
        eventId = coerceAuditEventId(input.eventId);
    }

    const eventType = coerceEventType(input.eventType, bounds);
    const source = coerceSourceId(input.source);
    const timestampMs = coerceTimestamp(input.timestampMs);

    const actor = coerceActorSubject(input.actor, "actor");
    const subject = coerceActorSubject(input.subject, "subject");
    const operation = coerceOperation(input.operation);

    let outcome = "unspecified";
    if (input.outcome !== undefined && input.outcome !== null) {
        if (!OUTCOMES.includes(input.outcome)) {
            throw new LedgerError(CODES.INVALID_EVENT, `outcome invalid: ${String(input.outcome)}`);
        }
        outcome = input.outcome;
    }

    const generation = input.generation === undefined || input.generation === null
        ? undefined
        : coerceGenerationRef(input.generation);

    const correlation = coerceCorrelation(input.correlation);
    const evidenceRefs = coerceEvidenceRefs(input.evidenceRefs, bounds);
    const authorityRef = coerceAuthorityRef(input.authorityRef);

    let causalParentId;
    if (input.causalParentId !== undefined && input.causalParentId !== null) {
        causalParentId = coerceAuditEventId(input.causalParentId);
    }

    // Metadata goes through the redaction boundary LAST so secret-shaped
    // values cannot survive validation even when everything else is fine.
    let metadata;
    try {
        metadata = sanitizeMetadata(input.metadata, bounds);
    }
    catch (error) {
        if (error instanceof LedgerError) throw error;
        throw new LedgerError(CODES.REDACTION_FAILED, `metadata rejected: ${error.message}`);
    }

    const record = {
        eventId: eventId ?? null, // assigned by ledger when absent
        eventType,
        source,
        timestampMs: timestampMs ?? null, // stamped by ledger clock when absent
        outcome,
        actor: actor ?? null,
        subject: subject ?? null,
        operation: operation ?? null,
        generation: generation ?? null,
        correlation: correlation ?? null,
        evidenceRefs: evidenceRefs ?? null,
        authorityRef: authorityRef ?? null,
        causalParentId: causalParentId ?? null,
        metadata: metadata ?? null
    };

    return record;
}

/** Digest core: everything except integrity block itself. */
function digestCore(record) {
    return canonicalJson({
        sequence: record.sequence,
        eventId: record.eventId,
        eventType: record.eventType,
        source: record.source,
        timestampMs: record.timestampMs,
        outcome: record.outcome,
        actor: record.actor,
        subject: record.subject,
        operation: record.operation,
        generation: record.generation,
        correlation: record.correlation,
        evidenceRefs: record.evidenceRefs,
        authorityRef: record.authorityRef,
        causalParentId: record.causalParentId,
        metadata: record.metadata
    }, { maxDepth: 24 });
}

module.exports = Object.freeze({
    OUTCOMES,
    ACTOR_KINDS,
    EVIDENCE_KINDS,
    AUTHORITY_REF_KINDS,
    RESERVED_EVENT_TYPES,
    ALLOWED_INPUT_KEYS,
    buildEventRecord,
    digestCore
});
