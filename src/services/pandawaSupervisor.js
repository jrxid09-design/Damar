"use strict";
// Werkudara's second role (owner design): PER-TURN SUPERVISION.
//
// The owner designed Werkudara not only as security/infrastructure but as
// the supervisory eye over every Damar and Pandawa turn: did the worker
// stay inside the instruction and the scope it was granted? Until now that
// role existed only as design text - no code reviewed a turn. This module
// is the minimal legitimate implementation:
//
//   reviewTurn({ workerId, task, sessionId, grantedTools, toolCalls,
//                deniedAttempts }) -> frozen record
//
// Detection is deterministic (no model): a tool call outside the granted
// capability set is a deviation (TOOL_OUT_OF_SCOPE); a tool attempt the
// guard already denied is a deviation (DENIED_ATTEMPT). The verdict is
// SESUAI or DEVIASI_TERDETEKSI. Deviations are recorded in a bounded
// ledger and escalated to Core through telemetry ('pandawa:supervision').
//
// The supervisor is NOT an authority: records carry authority: null, it
// never blocks, rewrites, or approves anything - it detects, records, and
// escalates. Decisions stay with Core / the Authority Gate, exactly like
// Werkudara's security mandate ("melapor dan mengusulkan, tidak pernah
// melewati Authority Gate").

const LEDGER_LIMIT = 200;

function createSupervisor({ publish = null, now = () => Date.now(), ledgerLimit = LEDGER_LIMIT } = {}) {
    const ledger = [];

    function reviewTurn({ workerId, task = "", sessionId = null, grantedTools = null, toolCalls = [], deniedAttempts = [] } = {}) {
        const findings = [];
        if (Array.isArray(grantedTools)) {
            for (const call of toolCalls || []) {
                const tool = typeof call === "string" ? call : call?.tool;
                if (typeof tool === "string" && !grantedTools.includes(tool)) {
                    findings.push(Object.freeze({ kind: "TOOL_OUT_OF_SCOPE", tool, severity: "deviation" }));
                }
            }
        }
        for (const attempt of deniedAttempts || []) {
            const tool = typeof attempt === "string" ? attempt : attempt?.tool;
            findings.push(Object.freeze({ kind: "DENIED_ATTEMPT", tool: typeof tool === "string" ? tool : null, severity: "deviation" }));
        }
        const verdict = findings.some((f) => f.severity === "deviation") ? "DEVIASI_TERDETEKSI" : "SESUAI";
        const record = Object.freeze({
            supervisor: "pandawa:werkudara",
            workerId: typeof workerId === "string" ? workerId : null,
            sessionId: typeof sessionId === "string" ? sessionId : null,
            task: String(task || "").slice(0, 200),
            verdict,
            findings: Object.freeze(findings),
            authority: null,
            at: now(),
        });
        ledger.push(record);
        if (ledger.length > ledgerLimit) ledger.splice(0, ledger.length - ledgerLimit);
        if (verdict === "DEVIASI_TERDETEKSI" && typeof publish === "function") {
            try { publish("pandawa:supervision", record); } catch { /* escalation is best-effort; the ledger is the record */ }
        }
        return record;
    }

    return Object.freeze({
        reviewTurn,
        records: () => [...ledger],
        deviations: () => ledger.filter((r) => r.verdict === "DEVIASI_TERDETEKSI"),
    });
}

let defaultSupervisor = null;
function getDefaultSupervisor() {
    if (!defaultSupervisor) {
        let publish = null;
        try {
            const telemetry = require("./telemetryService");
            if (telemetry && typeof telemetry.publish === "function") publish = (type, payload) => telemetry.publish(type, payload);
        } catch { /* telemetry unavailable: ledger-only supervision */ }
        defaultSupervisor = createSupervisor({ publish });
    }
    return defaultSupervisor;
}

module.exports = { createSupervisor, getDefaultSupervisor };
