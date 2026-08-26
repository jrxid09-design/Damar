"use strict";

/**
 * Audit Ledger V1 — persistence PORT.
 *
 * This is a CONTRACT only. V1 ships no durable adapter; deployment with
 * durability requirements MUST provide a production sink (e.g. SQLite:
 * transactional append, UNIQUE(event_id), monotonic sequence column,
 * bounded queries). See docs/architecture/audit-ledger-v1.md for the
 * adapter requirements and the in-memory implementation's guarantees.
 *
 * The port is intentionally narrow:
 *   - append(record): called by the ledger BEFORE its in-memory commit
 *     when { durable:true }, so a sink failure leaves the ledger fully
 *     unmutated. Synchronous only in V1 (async sinks would break the
 *     atomic ordering guarantee; a production adapter may relax this
 *     behind an explicit async API of its own).
 *
 * The ledger never reads from the sink in V1: restart recovery is the
 * production adapter's responsibility (load-then-continue semantics are
 * documented, not implemented here).
 */

class AuditPersistencePort {
    constructor(name) {
        if (typeof name !== "string" || name.length === 0) {
            throw new TypeError("AUDIT_PERSISTENCE_PORT_NAME_REQUIRED");
        }
        this.name = name;
    }

    /**
     * Persist one frozen audit record. Return true on success; throw to
     * reject (the ledger then refuses the append atomically).
     * @param {object} _record frozen stored AuditEvent
     * @returns {boolean}
     */
    append(_record) {
        throw new Error("AUDIT_PERSISTENCE_PORT_APPEND_ABSTRACT");
    }
}

module.exports = Object.freeze({ AuditPersistencePort });
