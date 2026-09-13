"use strict";

/**
 * W7-L7 GOVERNED LONG-HORIZON AUTONOMY CONVERGENCE.
 *
 * ACC subdomain `src/cognition/longhorizon/**` — COMPOSITION ONLY, owns no
 * new domain state (task card). Composes W7-L1..L6 into one bounded cycle.
 *
 * HARD BOUNDARY (verified structurally by tests/wave7/l7/convergenceAdversarial.test.js
 * scanning this module's own source, same pattern as MC-A5):
 *   this module imports NOTHING from src/action/** or src/authority/**.
 *   No function here ever constructs an ActionIntent, an authProof, or an
 *   AuthorityDecision. A cycle's plan/goal output is returned to the CALLER
 *   as data only — forming a real intent and evaluating it through Authority
 *   is the composition root's job, outside this module, through the
 *   existing Wave4 Action Intent / Authority owners.
 *
 * MODES (ARCH-Q-02, TC-ACC-03):
 *   off      -> cycle() is a no-op, returns null immediately.
 *   shadow   -> cycle() runs the full observe/evaluate pass; the return
 *               value is tagged decisionInfluence:false and nothing outside
 *               this module currently reads it (SHADOW = zero decision
 *               influence by the simple fact that no consumer exists yet).
 *   governed -> cycle() additionally returns a GovernedCognitiveProjection —
 *               a frozen, schema-checked read-only summary with no
 *               authority-shaped field, safe for a FUTURE Manager consumer
 *               to read as one advisory input alongside REQUEST_CLASS
 *               classification. This module does not itself wire that
 *               consumer — Manager's internal request-handling logic is
 *               untouched by this integration pass (see freeze evidence).
 */

const { MODES } = require("./bounds");
const { laws } = require("./laws");
const { createSelfModel } = require("../selfmodel");
const { createWorldModel } = require("../worldmodel");
const { createGoalEngine } = require("../goals");
const { createProspectiveMemory } = require("../prospective");
const { createAttentionEconomy } = require("../attention");
const { createMetacognition } = require("../metacog");

const AUTHORITY_SHAPED_KEYS = Object.freeze([
    "authorityDecision", "allow", "grant", "owner", "authProof",
    "capabilityGrant", "executionLease", "executor", "route", "trustedNode", "rootAuthority"
]);

const BELIEF_RANK = Object.freeze({ USABLE: 3, DEGRADED: 2, UNUSABLE: 1, UNKNOWN: 0 });

function assertNoAuthorityShapedFields(value, label) {
    if (!value || typeof value !== "object") return;
    for (const key of AUTHORITY_SHAPED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`ACC longhorizon: ${label} tidak boleh membawa field '${key}'`);
        }
    }
}

async function createLongHorizonCycle({
    mode = "off", capabilityRegistry, clock = { nowMs: () => Date.now() },
    stores = {}, auditLedger = null
} = {}) {

    if (!MODES.includes(mode)) mode = "off";

    if (mode === "off") {
        // GATE-W7-10: OFF => nothing is even constructed. Zero footprint.
        return Object.freeze({
            schemaVersion: require("./bounds").SCHEMA_VERSION,
            mode: "off", laws,
            async cycle() { return null; }
        });
    }

    const selfModel = await createSelfModel({ capabilityRegistry, clock, store: stores.selfmodel ?? null });
    const worldModel = await createWorldModel({ clock, store: stores.worldmodel ?? null });
    const goals = await createGoalEngine({ clock, store: stores.goals ?? null });
    const prospective = await createProspectiveMemory({ clock, store: stores.prospective ?? null });
    const attention = await createAttentionEconomy({ clock });
    const metacog = await createMetacognition({ clock });

    // --- L1-R1 closure: diff-based downgrade/eviction observer -----------
    // Reads ONLY selfModel.snapshot()'s existing frozen output — no change
    // to L1's public contract. Emits real Audit Ledger events when a real
    // ledger is supplied; always returns the events either way so tests can
    // verify the detection logic independent of ledger wiring.
    let previousAssessments = new Map(); // capabilityId -> selfBelief

    function auditSelfModelTransitions() {
        const snap = selfModel.snapshot();
        const events = [];
        const seenIds = new Set();

        for (const a of snap.capabilityAssessments) {
            seenIds.add(a.capabilityId);
            const prev = previousAssessments.get(a.capabilityId);
            if (prev !== undefined && BELIEF_RANK[a.selfBelief] < BELIEF_RANK[prev]) {
                events.push({ eventType: "cognition.selfmodel.downgrade", source: "acc.longhorizon",
                    outcome: "ok", metadata: { capabilityId: a.capabilityId, from: prev, to: a.selfBelief } });
            }
        }
        for (const [capabilityId, prevBelief] of previousAssessments) {
            if (!seenIds.has(capabilityId)) {
                events.push({ eventType: "cognition.selfmodel.eviction", source: "acc.longhorizon",
                    outcome: "ok", metadata: { capabilityId, lastKnownBelief: prevBelief } });
            }
        }

        previousAssessments = new Map(snap.capabilityAssessments.map(a => [a.capabilityId, a.selfBelief]));

        for (const event of events) {
            if (auditLedger && typeof auditLedger.append === "function") {
                try { auditLedger.append(event); } catch { /* audit failure never blocks cognition */ }
            }
        }
        return events;
    }

    function buildGovernedProjection() {
        const selfSnap = selfModel.snapshot();
        const openContradictions = worldModel.openContradictions();
        const pick = attention.pick();

        const projection = Object.freeze({
            schemaVersion: "governedCognitiveProjection.v1",
            generatedAtMs: clock.nowMs(),
            selfModel: Object.freeze({
                capabilityCount: selfSnap.capabilityAssessments.length,
                unknownCount: selfSnap.unknowns.length,
                healthState: selfSnap.healthState
            }),
            worldModel: Object.freeze({ openContradictionCount: openContradictions.length }),
            attentionFocus: pick ? Object.freeze({ targetId: pick.targetId, workKind: pick.workKind }) : null,
            decisionInfluence: "ADVISORY_ONLY"
        });

        assertNoAuthorityShapedFields(projection, "GovernedCognitiveProjection");
        assertNoAuthorityShapedFields(projection.selfModel, "GovernedCognitiveProjection.selfModel");
        return projection;
    }

    async function cycle() {
        const auditEvents = auditSelfModelTransitions();
        const reminders = prospective.tick();
        const contradictions = worldModel.openContradictions();

        const result = {
            mode, decisionInfluence: mode === "shadow" ? false : "ADVISORY_ONLY",
            auditEvents, remindersFired: reminders.length, openContradictions: contradictions.length
        };

        if (mode === "governed") {
            result.projection = buildGovernedProjection();
        }

        return Object.freeze(result);
    }

    return Object.freeze({
        schemaVersion: require("./bounds").SCHEMA_VERSION,
        mode, laws,
        cycle,
        // Exposed for convergence tests / future integration-window wiring —
        // read-only references to the composed lanes, never new state here.
        lanes: Object.freeze({ selfModel, worldModel, goals, prospective, attention, metacog })
    });
}

module.exports = { createLongHorizonCycle, laws, AUTHORITY_SHAPED_KEYS };
