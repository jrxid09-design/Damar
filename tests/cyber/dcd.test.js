"use strict";
/**
 * DCD PRODUCTION TESTS
 *
 * Tests the six DCD plane modules against the core invariants from
 * the Master Execution Contract §12 and the DCD law constants.
 *
 * node --test "tests/cyber/dcd.test.js"
 */

const test   = require("node:test");
const assert = require("node:assert/strict");

const contracts = require("../../src/cyber/contracts");
const sensor    = require("../../src/cyber/sensor");
const state     = require("../../src/cyber/state");
const intel     = require("../../src/cyber/intelligence");
const mission   = require("../../src/cyber/mission");
const action    = require("../../src/cyber/action");
const assurance = require("../../src/cyber/assurance");
const laws      = require("../../src/cyber/laws");

const NOW = 1_760_000_000_000;

/* ---------------------------------------------------------------- helpers */

function makeEnvelope(overrides = {}) {
    return contracts.makeMissionEnvelope({
        mission_id:           "m-test",
        principal:            "owner",
        objective:            "dcd production test",
        authority_reference:  "auth-test",
        authorized_scope:     ["scope:net"],
        asset_scope:          ["host:web01"],
        allowed_capabilities: ["http-probe"],
        allowed_methods:      ["GET"],
        prohibited_methods:   [],
        max_risk_level:       "MEDIUM",
        rate_budget:          { requestsPerMinute: 60 },
        time_window:          { start: NOW, end: NOW + 3_600_000 },
        max_concurrency:      2,
        data_access_limit:    "METADATA_ONLY",
        credential_policy:    { leaseOnly: true, maxLeaseMs: 600_000 },
        allowed_pivot_depth:  0,
        verification_policy:  "MEDIUM",
        operation_mode:       "DCD_DEFENSE",
        ...overrides,
    });
}

/* ----------------------------------------------------------------- laws */

test("LAWS: security constraints and authority posture frozen", () => {
    const { SECURITY_CONSTRAINTS, AUTHORITY_POSTURE } = laws;

    assert.equal(SECURITY_CONSTRAINTS.DETECTION_NEQ_AUTHORITY, true);
    assert.equal(SECURITY_CONSTRAINTS.INCIDENT_CONFIRMED_NEQ_AUTHORIZED, true);
    assert.equal(SECURITY_CONSTRAINTS.THREAT_SCORE_NEQ_AUTHORITY, true);
    assert.equal(SECURITY_CONSTRAINTS.KALI_NEQ_AUTHORITY, true);
    assert.equal(SECURITY_CONSTRAINTS.SIMULATION_NEQ_EXECUTION, true);
    assert.equal(SECURITY_CONSTRAINTS.UNCERTAIN_PRIOR_NEQ_SAFE_TO_RETRY, true);
    assert.equal(SECURITY_CONSTRAINTS.REPLAY_CACHE_NEQ_REPLAY_AUTHORITY, true);

    assert.equal(AUTHORITY_POSTURE.DCD_RECOMMENDS_NEVER_AUTHORIZES, true);
    assert.equal(AUTHORITY_POSTURE.NO_DIRECT_DCD_TO_SHELL, true);
    assert.equal(AUTHORITY_POSTURE.NO_DIRECT_DCD_TO_KALI, true);
    assert.equal(AUTHORITY_POSTURE.KALI_GOVERNED_CAPABILITY_ONLY, true);
    assert.equal(AUTHORITY_POSTURE.CANONICAL_AUTHORITY_PATH_REQUIRED, true);

    assert.equal(Object.isFrozen(SECURITY_CONSTRAINTS), true);
    assert.equal(Object.isFrozen(AUTHORITY_POSTURE), true);
});

/* --------------------------------------------------------------- sensor */

test("SENSOR: normalizes valid network observation to T4 record", () => {
    const result = sensor.normalizeObservation({
        observationId: "obs-1",
        sourceKind:    "network",
        rawRef:        "raw://seg/001",
        summary:       "SYN scan on port 443",
        observedAt:    NOW,
        ttlMs:         60_000,
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(contracts.ALLOWED_TIERS.includes(result.record.tier));
    assert.equal(result.record.authorityRef, undefined);
});

test("SENSOR: rejects unknown sourceKind", () => {
    const r = sensor.normalizeObservation({
        observationId: "obs-2", sourceKind: "MAGIC_ORACLE",
        rawRef: "raw://x", summary: "s", observedAt: NOW,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /unknown sourceKind/.test(e)));
});

test("SENSOR: rawRef required — no inline payload (DC-53)", () => {
    const r = sensor.normalizeObservation({
        observationId: "obs-3", sourceKind: "host",
        rawRef: null, summary: "s", observedAt: NOW,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => /rawRef/.test(e)));
});

test("SENSOR: admitTelemetry separates accepted from rejected", () => {
    const good = { observationId: "o1", sourceKind: "host", rawRef: "raw://x/1", summary: "s", observedAt: NOW };
    const bad  = { observationId: "o2", sourceKind: "NOPE" };
    const { accepted, rejected } = sensor.admitTelemetry([good, bad]);
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
});

test("SENSOR: observation store TTL eviction (CACHE != TRUTH)", () => {
    const store = sensor.createObservationStore();
    const { record } = sensor.normalizeObservation({
        observationId: "ev-ttl", sourceKind: "host", rawRef: "raw://x/2", summary: "s", observedAt: NOW,
    });
    const short = { ...record, ttlMs: 1 };
    store.put(short);
    // sweep with far-future nowMs evicts all expired entries
    store.sweep(Infinity);
    assert.equal(store.get("ev-ttl"), null);
});

/* --------------------------------------------------------- cyber state */

test("STATE: upsertEntity enforces closed vocabulary", () => {
    const g = state.createCyberStateProjection();
    const e = g.upsertEntity({ entityId: "h1", kind: "Host", observedAt: NOW });
    assert.equal(e.entityId, "h1");
    assert.throws(() => g.upsertEntity({ entityId: "x", kind: "ALIEN", observedAt: NOW }), /unknown entity kind/);
});

test("STATE: edges carry executable=false (DC-07)", () => {
    const g = state.createCyberStateProjection();
    g.upsertEntity({ entityId: "a", kind: "Host", observedAt: NOW });
    g.upsertEntity({ entityId: "b", kind: "Service", observedAt: NOW });
    const edge = g.upsertEdge("a", "runs", "b", "OBSERVED", []);
    assert.equal(edge.executable, false);
});

test("STATE: bounded query refuses missing assetScope (DC-58)", () => {
    const g = state.createCyberStateProjection();
    const r = g.query({});
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ASSET_SCOPE_REQUIRED");
});

test("STATE: bounded query refuses excessive maxDepth (DC-58)", () => {
    const g = state.createCyberStateProjection();
    const r = g.query({ assetScope: ["h1"], maxDepth: 999 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "MAX_DEPTH_EXCEEDS_BOUND");
});

test("STATE: query within scope returns paths", () => {
    const g = state.createCyberStateProjection();
    g.upsertEntity({ entityId: "h1", kind: "Host", observedAt: NOW });
    g.upsertEntity({ entityId: "svc1", kind: "Service", observedAt: NOW });
    g.upsertEdge("h1", "runs", "svc1", "OBSERVED", []);
    const r = g.query({ assetScope: ["h1"] });
    assert.equal(r.ok, true);
    assert.ok(r.paths.length > 0);
});

/* -------------------------------------------------------- intelligence */

test("INTEL: createIncident starts HYPOTHESIS_OPEN, no authority (DC-10/DC-70)", () => {
    const engine = intel.createDetectionEngine();
    const inc = engine.createIncident({
        incidentId: "inc-1", riskLevel: "HIGH", summary: "suspicious auth",
        evidence: ["ev-1"], nowMs: NOW,
    });
    assert.equal(inc.state, "HYPOTHESIS_OPEN");
    assert.equal(inc.authorizedAction, null);
});

test("INTEL: CONFIRMED never jumps to CONTAINING; AUTHORIZED required (DC-71)", () => {
    const engine = intel.createDetectionEngine();
    engine.createIncident({ incidentId: "inc-2", riskLevel: "MEDIUM", nowMs: NOW });
    for (const s of ["SUSPICIOUS", "HYPOTHESIS_OPEN", "CORROBORATING", "INCIDENT_CONFIRMED"]) {
        engine.transition("inc-2", s);
    }

    const bad = engine.transition("inc-2", "CONTAINING");
    assert.equal(bad.ok, false, "INCIDENT_CONFIRMED → CONTAINING must be refused");

    assert.equal(engine.transition("inc-2", "CONTAINMENT_PROPOSED").ok, true);
    assert.equal(engine.transition("inc-2", "AUTHORIZED").ok, true);
    assert.equal(engine.transition("inc-2", "CONTAINING").ok, true);
});

test("INTEL: score is deterministic ranking only (DC-12)", () => {
    const engine = intel.createDetectionEngine();
    const s = engine.score({ factors: { exploitability: 1, reachability: 0.8 } });
    assert.equal(s.rankingOnly, true);
    assert.equal(s.authorityRef, null);
    assert.equal(s.deterministic, true);
});

/* ----------------------------------------------------------- mission */

test("MISSION: createMission wraps makeMissionEnvelope; envelope immutable (DC-106)", () => {
    const r = mission.createMission({
        missionId:      "m-dcd-1",
        envelopeParams: {
            mission_id: "m-dcd-1", principal: "owner",
            objective: "test mission", authority_reference: "auth-1",
        },
        nowMs: NOW,
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(Object.isFrozen(r.mission.envelope), true);
    assert.equal(r.mission.budgetLedger.elapsedMs, 0);
    assert.equal(r.mission.budgetLedger.data_records, undefined); // DC-LEDGER: invalid key absent
});

test("MISSION: createMission fails closed on bad envelope params", () => {
    const r = mission.createMission({ missionId: "m-bad", envelopeParams: {} });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
});

test("MISSION: evalDecision denies when mission closed (DC-54)", () => {
    const r = mission.createMission({
        missionId: "m-close",
        envelopeParams: {
            mission_id: "m-close", principal: "owner", objective: "o", authority_reference: "a",
        },
        nowMs: NOW,
    });
    const closed = mission.closeMission(r.mission);
    const d = mission.evalDecision(closed, { at: NOW + 1, capability: "http-probe" }, null, NOW + 1);
    assert.equal(d.decision, "DENY");
    assert.equal(d.reason, "mission is closed");
});

/* ------------------------------------------------------------- action */

test("ACTION: registerCyberActuator stores descriptor", () => {
    const r = action.registerCyberActuator({
        capabilityId: "kali-recon", operations: ["nmap", "nikto"], isSimulation: false,
    });
    assert.equal(r.ok, true);
    assert.ok(action.listActuators().some(a => a.capabilityId === "kali-recon"));
});

test("ACTION: makeSecurityIntent builds ActionIntent without dispatch method (DC-07)", () => {
    const env = makeEnvelope();
    const intent = action.makeSecurityIntent(env, { capabilityId: "http-probe", operation: "GET" }, "corr-1");
    assert.equal(typeof intent.capabilityId, "string");
    assert.equal(intent.metadata.envelopeRef, "auth-test");
    assert.equal(typeof intent.execute, "undefined");
    assert.equal(typeof intent.dispatch, "undefined");
});

test("ACTION: makeSecurityIntent refuses missing capabilityId", () => {
    const env = makeEnvelope();
    assert.throws(() => action.makeSecurityIntent(env, { operation: "GET" }), /capabilityId/);
});

/* ---------------------------------------------------------- assurance */

test("ASSURANCE: recordEvidence refuses T1/T3 (DC-61/DC-08)", () => {
    for (const t of ["T1", "T3"]) {
        const r = assurance.recordEvidence({
            evidenceId: `ev-${t}`, kind: "OBSERVATION",
            sourceRef: "sensor:1", observedAt: NOW, tier: t,
        });
        assert.equal(r.ok, false, `tier ${t} must be refused`);
        assert.ok(r.errors.some(e => /DC-61|DC-08/.test(e)));
    }
});

test("ASSURANCE: recordEvidence accepts DCD-allowed tiers T4/T5/T7/T10", () => {
    for (const t of ["T4", "T5", "T7", "T10"]) {
        const r = assurance.recordEvidence({
            evidenceId: `ev-ok-${t}`, kind: "OBSERVATION",
            sourceRef: "sensor:1", observedAt: NOW, tier: t, epistemicClass: "OBSERVED",
        });
        assert.equal(r.ok, true, `tier ${t} should be allowed: ${JSON.stringify(r.errors)}`);
    }
});

test("ASSURANCE: registerCyberVerifier stores descriptor (DC-61)", () => {
    const r = assurance.registerCyberVerifier({ verifierId: "ver-1", verifies: ["post_state"] });
    assert.equal(r.ok, true);
    assert.ok(assurance.listVerifiers().some(v => v.verifierId === "ver-1"));
});

test("ASSURANCE: verifyEffect delegates to verifyCompletion (DC-60/DC-62)", () => {
    const env = makeEnvelope();
    // MEDIUM profile + envelope with cleanup_required → must include cleanup_completed
    const result = assurance.verifyEffect("MEDIUM", ["post_state", "process_state", "cleanup_completed"], env, "http-probe");
    assert.equal(result.ok, true, JSON.stringify(result));
});

test("ASSURANCE: checkCleanup enforces DC-64", () => {
    const env = makeEnvelope();
    const r = assurance.checkCleanup(env, ["post_state"]);
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("cleanup_completed"));
});

/* -------------------------------------------- defense/offense boundary */

test("BOUNDARY: detection score never confers authority (§12 invariants)", () => {
    const s = contracts.scoreFinding({ factors: { exploitability: 1, reachability: 1 } });
    assert.equal(s.authorityRef, null);
    assert.equal(s.rankingOnly, true);

    assert.equal(laws.SECURITY_CONSTRAINTS.THREAT_SCORE_NEQ_AUTHORITY, true);
    assert.equal(laws.SECURITY_CONSTRAINTS.VULNERABILITY_NEQ_EXPLOIT_AUTH, true);
    assert.equal(laws.SECURITY_CONSTRAINTS.SIMULATION_NEQ_EXECUTION, true);
});

test("BOUNDARY: Kali intent has no run/exec method; KALI_NEQ_AUTHORITY holds (§14)", () => {
    action.registerCyberActuator({
        capabilityId: "kali-exploit", operations: ["msfconsole"], isSimulation: false,
    });
    const env = makeEnvelope({ allowed_capabilities: ["kali-exploit"] });
    const intent = action.makeSecurityIntent(env, { capabilityId: "kali-exploit", operation: "msfconsole" });
    assert.equal(typeof intent.run, "undefined");
    assert.equal(typeof intent.exec, "undefined");
    assert.equal(laws.SECURITY_CONSTRAINTS.KALI_NEQ_AUTHORITY, true);
    assert.equal(laws.AUTHORITY_POSTURE.NO_DIRECT_DCD_TO_KALI, true);
});

test("BOUNDARY: INCIDENT_CONFIRMED carries no authority grant (§12/DC-70)", () => {
    const engine = intel.createDetectionEngine();
    engine.createIncident({ incidentId: "inc-boundary", riskLevel: "CRITICAL", nowMs: NOW });
    for (const s of ["SUSPICIOUS", "HYPOTHESIS_OPEN", "CORROBORATING", "INCIDENT_CONFIRMED"]) {
        engine.transition("inc-boundary", s);
    }
    const inc = engine.getIncident("inc-boundary");
    assert.equal(inc.state, "INCIDENT_CONFIRMED");
    assert.equal(inc.authorizedAction, null);
});
