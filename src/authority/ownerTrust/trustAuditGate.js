"use strict";

/**
 * OWNER TRUST AUDIT GATE (Wave 5 Lane 4 repair, OT-007).
 *
 * The SINGLE mandatory audit path for every Owner Trust mutation.  The
 * canonical composition wires this gate into the OwnerTrustRegistry; the
 * registry's own emitAudit calls funnel through it.
 *
 * PROPERTIES:
 *   - The gate appends to the canonical Audit Ledger with durable:true when
 *     the composition is durable (the ledger/sink enforces validation and
 *     persistence; a rejected event THROWS here — the gate never invents
 *     event ids, sequences, or digests, and never writes raw files itself).
 *   - The gate NEVER fabricates events on behalf of callers and accepts no
 *     caller-supplied eventId/sequence/timestamp (the ledger owns those).
 *   - Audit failure must not take down the trust operation (ledger
 *     discipline), but it must NOT be silent: the gate records every
 *     rejection (count + last error code) and exposes health() so the
 *     composition and the console can surface a degraded audit path.
 *   - TF-001 RESTART CONTINUATION: the composition passes the sink's
 *     verified durable tail (describeDurable()) into the ledger at
 *     construction, so the sequence/digest chain resumes across restarts
 *     without any manual step.
 */

function gateError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    return error;
}

/**
 * createTrustAuditGate({ ledger, source = "ownerTrust" })
 *   ledger — the canonical AuditLedger instance (append() throws on
 *            validation/persistence failure; that throw is the gate's
 *            failure signal).
 */
function createTrustAuditGate({ ledger, source = "ownerTrust" } = {}) {
    if (!ledger || typeof ledger.append !== "function") {
        throw gateError("OT_AUDIT_GATE_INVALID", "trust audit gate requires the canonical Audit Ledger");
    }
    const stats = { appended: 0, rejected: 0, lastError: null };

    /**
     * The registry-compatible audit sink:
     *   audit({ eventType, source?, metadata? }) — throws on failure.
     * Metadata is passed through verbatim; the ledger applies its own
     * redaction/size bounds.  No caller field is trusted for identity.
     */
    function audit({ eventType, source: eventSource, metadata = null } = {}) {
        try {
            ledger.append({
                eventType,
                source: typeof eventSource === "string" && eventSource.length > 0
                    ? eventSource
                    : source,
                metadata,
                outcome: "ok"
            }, { durable: true });
            stats.appended += 1;
        } catch (error) {
            stats.rejected += 1;
            stats.lastError = {
                code: error && error.code ? error.code : "E_INTERNAL",
                message: String(error && error.message ? error.message : error)
            };
            throw error;
        }
    }

    /** Never-throwing variant for paths that must not propagate. */
    function auditSafe(input) {
        try {
            audit(input);
            return true;
        } catch {
            return false;
        }
    }

    /** Degraded-audit visibility for the composition and console. */
    function health() {
        return Object.freeze({
            ok: stats.rejected === 0,
            appended: stats.appended,
            rejected: stats.rejected,
            lastError: stats.lastError ? Object.freeze({ ...stats.lastError }) : null
        });
    }

    return Object.freeze({ audit, auditSafe, health });
}

module.exports = Object.freeze({ createTrustAuditGate });
