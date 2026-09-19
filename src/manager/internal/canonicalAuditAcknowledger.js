"use strict";

/**
 * W8-IW1 — CANONICAL AUDIT ACKNOWLEDGER.
 *
 * `core/safety/auditTrail.record` is deliberately best-effort: it swallows every
 * failure and returns nothing, so it can never be an acknowledgement. The
 * canonical bridge therefore requires a real, verifiable acknowledgement before
 * it will publish completion (AUDIT CALLBACK RETURN != AUTHORITY, and equally
 * "a write that may have silently failed" != acknowledgement).
 *
 * This acknowledger writes one JSON line and then READS IT BACK. Only if the
 * exact record (by `receipt`) is present on disk does it acknowledge. It grants
 * nothing: it is a durability port, not an authority.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const auditTrail = require("../../core/safety/auditTrail");

function createCanonicalAuditAcknowledger({ dir = null, file = null, now = () => Date.now() } = {}) {
    const baseDir = dir ?? auditTrail.DIR ?? path.join(process.cwd(), "data", "audit");
    const target = file ?? path.join(baseDir, "canonical-execution.jsonl");

    return function acknowledge(entry) {
        const receipt = `ack_${crypto.randomBytes(8).toString("hex")}`;
        const line = JSON.stringify({
            at: new Date(now()).toISOString(),
            receipt,
            kind: "canonical_capability_execution",
            capabilityId: entry?.capabilityId ?? null,
            operation: entry?.operation ?? null,
            requestId: entry?.requestId ?? null,
            verificationState: entry?.verificationState ?? null
        });

        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.appendFileSync(target, `${line}\n`, "utf8");

            // Read back: the acknowledgement is evidence the record is durable,
            // not a claim that a write was attempted.
            const contents = fs.readFileSync(target, "utf8");
            const durable = contents.length >= line.length &&
                contents.slice(-(line.length + 1), -1) === line;

            if (!durable) return { ok: false, receipt: null, reason: "RECORD_NOT_DURABLE" };
            return { ok: true, receipt };
        }
        catch {
            return { ok: false, receipt: null, reason: "AUDIT_UNAVAILABLE" };
        }
    };
}

module.exports = { createCanonicalAuditAcknowledger };
