"use strict";

/**
 * AUDIT / PROVENANCE LEDGER V1 — public surface.
 *
 * Canonical, bounded, append-oriented observational record of what
 * happened across Aether subsystems. See docs/architecture/
 * audit-ledger-v1.md for the binding design contract.
 *
 * LAWS (restated at the surface):
 *   - An AuditEvent is an OBSERVATION, never Authority, never current
 *     truth, never executable history. Recovery must not replay these
 *     events as commands; there is deliberately no replay API.
 *   - Recording approval != ratification; recording capability !=
 *     grant; logging an action != executing it.
 *   - The ledger imports NOTHING outside node:crypto + itself. It can
 *     neither mutate nor invoke any other subsystem (structurally
 *     proven by tests/auditLedger/structural.test.js).
 */

const errors = require("./errors");
const config = require("./config");
const ids = require("./ids");
const events = require("./events");
const redact = require("./redact");
const integrity = require("./integrity");
const ledger = require("./ledger");
const ports = require("./ports");

module.exports = Object.freeze({
    createAuditLedger: ledger.createAuditLedger,
    LedgerError: errors.LedgerError,
    LEDGER_ERROR_CODES: errors.CODES,
    DEFAULT_BOUNDS: config.DEFAULT_BOUNDS,
    resolveBounds: config.resolveBounds,
    newAuditEventId: ids.newAuditEventId,
    coerceAuditEventId: ids.coerceAuditEventId,
    CORRELATION_KEYS: ids.CORRELATION_KEYS,
    OUTCOMES: events.OUTCOMES,
    ACTOR_KINDS: events.ACTOR_KINDS,
    EVIDENCE_KINDS: events.EVIDENCE_KINDS,
    AUTHORITY_REF_KINDS: events.AUTHORITY_REF_KINDS,
    RESERVED_EVENT_TYPES: events.RESERVED_EVENT_TYPES,
    sanitizeMetadata: redact.sanitizeMetadata,
    sha256Hex: integrity.sha256Hex,
    isValidDigestFormat: integrity.isValidDigestFormat,
    AuditPersistencePort: ports.AuditPersistencePort
});
