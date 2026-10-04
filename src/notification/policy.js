"use strict";

// THE canonical Surface Notification policy owner (DP §43). Exactly one place
// decides whether a source condition produces no notification, an ambient
// indication, normal attention, high attention, or interruptive/security
// attention. This policy lives in the domain, NOT in Presence or the Dashboard.
//
// SALIENCE != AUTHORITY (DP §44): a level is attention weight only. URGENT,
// SECURITY_CRITICAL and HIGH_ATTENTION confer no execution permission.

const LEVEL = Object.freeze({
    NONE: "NONE",
    AMBIENT: "AMBIENT",
    NORMAL: "NORMAL",
    HIGH: "HIGH",
    INTERRUPTIVE: "INTERRUPTIVE"
});

const ORDER = Object.freeze([LEVEL.NONE, LEVEL.AMBIENT, LEVEL.NORMAL, LEVEL.HIGH, LEVEL.INTERRUPTIVE]);
function rank(level) { const i = ORDER.indexOf(level); return i < 0 ? 0 : i; }

const SEVERITY_FLOOR = Object.freeze({
    none: LEVEL.NONE, low: LEVEL.AMBIENT, normal: LEVEL.NORMAL,
    high: LEVEL.HIGH, critical: LEVEL.INTERRUPTIVE
});

// Source-backed mapping. Uses existing product semantics (approvals need a
// decision, security incidents interrupt, mission progress is ambient). Returns
// the MORE salient of the source rule and the severity floor, so an escalated
// severity on the same source raises attention rather than being ignored.
function classify({ sourceKind, event = null, severity = "normal" } = {}) {
    const floor = SEVERITY_FLOOR[String(severity).toLowerCase()] ?? LEVEL.NORMAL;
    // severity "none" is an explicit suppression signal: no notification at all,
    // regardless of source (DP §43 "no notification").
    if (floor === LEVEL.NONE) return LEVEL.NONE;
    let base;
    switch (sourceKind) {
        case "approval":
            base = event === "resolved" ? LEVEL.AMBIENT : LEVEL.NORMAL; // a PENDING approval needs a human decision
            break;
        case "security_incident": // DCD incidents ride the canonical security_incident entity type
            base = (event === "confirmed" || event === "detected") ? LEVEL.INTERRUPTIVE : LEVEL.HIGH;
            break;
        case "mission":
        case "coding_mission":
            base = (event === "failed") ? LEVEL.NORMAL : (event === "completed" ? LEVEL.NORMAL : LEVEL.AMBIENT);
            break;
        case "device":
        case "provider":
            base = (event === "error" || event === "offline") ? LEVEL.HIGH : LEVEL.AMBIENT;
            break;
        default:
            base = LEVEL.NORMAL;
    }
    return rank(base) >= rank(floor) ? base : floor;
}

module.exports = { LEVEL, classify, rank };
