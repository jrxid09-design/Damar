"use strict";

/**
 * W8-L7 EMBODIED CONVERGENCE CERTIFICATION
 *
 * Cross-lane composition and convergence of L1-L6 as an integrated system.
 * Each test is labelled with its convergence-scenario identifier (CS-W8-xx)
 * and the hard invariant it asserts, per the frozen W8 contract
 * (WAVE8_CONTRACTS_FROZEN.md §W8-L7).
 *
 * Scope: composition, authority boundaries, completion path, ephemeral state,
 * uncertain-effect safety, no-second-dispatcher, and import-graph proofs.
 * Unit-level L6 verifier tests live in tests/wave8/l6/closedloop.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");

const { createRuntimeCore } = require("../../../src/integration/canonicalRuntimeComposition");
const {
    createClosedLoop, createCompletionVerifier, PHASE, LOOP_ORDER, BOUNDS, laws
} = require("../../../src/cognition/closedloop");

// ── helpers ───────────────────────────────────────────────────────────────

function makeAuditLedger() {
    const events = [];
    return { ledger: { append(e) { events.push(e); return { ignored: true }; } }, events };
}

function cognitionOpts(overrides = {}) {
    return {
        enableCognition: true,
        cognitionMode: "shadow",
        cognitionCapabilityRegistry: {
            get: () => null,
            has: () => false,
            getAvailability: () => "UNKNOWN"
        },
        cognitionAuditLedger: makeAuditLedger().ledger,
        ...overrides
    };
}

function makeEvidence(records = {}) {
    return ({ probeId }) => (probeId in records ? records[probeId] : null);
}

function canonicalEvidence(probeId, obsOverride) {
    const obs = obsOverride ?? {
        tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8
    };
    return { outcome: "VERIFIED", probeId, questionRef: "q-1", capabilityId: "cap-1", observation: obs };
}

// ── CS-W8-01: OFF / inactive ──────────────────────────────────────────────

test("CS-W8-01: closedLoop and perceptionLane are null when enableCognition is off", async () => {
    const core = await createRuntimeCore({});
    try {
        assert.equal(core.closedLoop, null);
        assert.equal(core.perceptionLane, null);
    } finally {
        core.shutdown();
    }
});

// ── CS-W8-02: cross-lane composition ─────────────────────────────────────

test("CS-W8-02a: all cognition lanes compose when enableCognition is true", async () => {
    const core = await createRuntimeCore(cognitionOpts());
    try {
        assert.ok(core.closedLoop !== null, "closedLoop must be composed");
        assert.ok(core.perceptionLane !== null, "perceptionLane must be composed");
        assert.equal(typeof core.closedLoop.runCycle, "function");
        assert.equal(typeof core.closedLoop.getPhase, "function");
        assert.equal(typeof core.closedLoop.getLoopStatus, "function");
        assert.equal(typeof core.perceptionLane.openQuestion, "function");
        assert.equal(typeof core.perceptionLane.scheduleProbe, "function");
    } finally {
        core.shutdown();
    }
});

test("CS-W8-02b: cross-lane laws and bounds are published on the frozen surface", async () => {
    const core = await createRuntimeCore(cognitionOpts());
    try {
        assert.equal(core.closedLoop.laws.ONE_FRESH_EVALUATION_PER_EFFECT, true);
        assert.equal(core.closedLoop.laws.NO_SECOND_DISPATCHER, true);
        assert.equal(core.closedLoop.laws.VERIFY_AUTHORIZE_NEVER_SILENTLY_SKIPPED, true);
        assert.equal(core.closedLoop.bounds.MIN_LOOP_INTERVAL_MS, BOUNDS.MIN_LOOP_INTERVAL_MS);
        assert.equal(core.closedLoop.bounds.MAX_STAGES, BOUNDS.MAX_STAGES);
    } finally {
        core.shutdown();
    }
});

// ── CS-W8-03: authority invariants ───────────────────────────────────────

test("CS-W8-03a: MODEL != AUTHORITY — no public seam to mint completion evidence", async () => {
    const core = await createRuntimeCore(cognitionOpts());
    try {
        assert.equal(core.closedLoop.admitCanonicalProbeCompletion, undefined,
            "no public completion-admission seam must exist on the closed loop");
    } finally {
        core.shutdown();
    }
});

test("CS-W8-03b: TOOL != AUTHORITY — closedloop imports nothing from action or authority (path-exhaustive)", () => {
    // Enumerate ALL require() calls and verify none resolves to an action,
    // authority, or actuator path. This catches both absolute-style paths
    // ("/action/", "/authority/") and relative-style paths ("../action",
    // "../../authority/...") that a fixed-prefix regex would miss.
    const src = fs.readFileSync(path.join(ROOT, "src/cognition/closedloop/index.js"), "utf8");
    const deps = [...src.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map(m => m[1]);
    for (const dep of deps) {
        assert.ok(!/\/action(\/|$)/.test(dep),
            `closedloop must not require "${dep}" (action module)`);
        assert.ok(!/\/authority(\/|$)/.test(dep),
            `closedloop must not require "${dep}" (authority module)`);
        assert.ok(!dep.includes("actuator"),
            `closedloop must not require "${dep}" (actuator module)`);
    }
});

test("CS-W8-03c: NO_SECOND_DISPATCHER — no dispatch() call inside closedloop", () => {
    assert.equal(laws.NO_SECOND_DISPATCHER, true);
    const src = fs.readFileSync(path.join(ROOT, "src/cognition/closedloop/index.js"), "utf8");
    assert.doesNotMatch(src, /\bdispatch\s*\(/, "closedloop must not call dispatch()");
    assert.doesNotMatch(src, /createDispatch/, "closedloop must not create a dispatcher");
});

// ── CS-W8-04: PERCEPTION != AUTHORITY — L2 probe scheduling ──────────────

test("CS-W8-04a: PERCEPTION != AUTHORITY — every dispatch: line in perception module is null", () => {
    // Line-by-line exhaustive check: every source line that contains `dispatch:`
    // must assign null. This catches dispatch: (expr), dispatch: !0, dispatch: 1,
    // and other non-null forms that a character-class regex would miss.
    const src = fs.readFileSync(path.join(ROOT, "src/cognition/perception/index.js"), "utf8");
    const dispatchLines = src.split("\n").filter(l => /\bdispatch\s*:/.test(l));
    assert.ok(dispatchLines.length > 0, "perception/index.js must contain at least one dispatch: wiring");
    for (const line of dispatchLines) {
        assert.match(line, /\bdispatch\s*:\s*null\b/,
            `every dispatch: assignment must be null — offending line: ${line.trim()}`);
    }
    // Also check for dynamic property dispatch assignment (obj.dispatch = fn or obj["dispatch"] = fn).
    const dynamicDispatchLines = src.split("\n").filter(l =>
        /\.dispatch\s*=/.test(l) && !/\.dispatch\s*=\s*null\b/.test(l)
    );
    assert.equal(dynamicDispatchLines.length, 0,
        `no non-null dynamic dispatch assignment (.dispatch = ...) allowed: ${dynamicDispatchLines.join("; ")}`);
    // No dispatcher import.
    assert.doesNotMatch(src, /require\s*\(\s*["'][^"']*\/dispatch/,
        "perception module must not import a dispatcher");
});

test("CS-W8-04b: L2-L6 completion path is fail-closed without canonical execution evidence", () => {
    // Canonical wiring: completionEvidence = () => null.
    // Every verifyCompletion call therefore fails closed.
    const verifier = createCompletionVerifier({ completionEvidence: () => null });
    assert.equal(
        verifier.verifyCompletion({
            probeId: "p-fc",
            request: { probeId: "p-fc", questionRef: "q-1", capabilityId: "cap-1" },
            outcome: "SUCCESS",
            observation: { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 }
        }),
        false,
        "null completionEvidence must produce fail-closed: false"
    );
});

// ── CS-W8-05: REPLAY CACHE != REPLAY AUTHORITY ───────────────────────────

test("CS-W8-05: REPLAY CACHE != REPLAY AUTHORITY — same probeId rejected after first admission", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    const ev = canonicalEvidence("p-once", obs);
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-once": ev }) });
    const spec = { probeId: "p-once", request: { probeId: "p-once", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs };
    assert.equal(verifier.verifyCompletion(spec), true, "first verification must succeed");
    assert.equal(verifier.verifyCompletion(spec), false, "replay must be rejected");
    // The verifier exposes ONLY verifyCompletion — no surface to read or mint
    // from the completed-set cache. The cache record cannot itself authorize.
    const surface = Object.keys(verifier);
    assert.deepEqual(surface, ["verifyCompletion"],
        "verifier must expose exactly verifyCompletion — no cache-read or mint surface");
});

// ── CS-W8-06: UNCERTAIN PRIOR EFFECT != SAFE TO RETRY ───────────────────

test("CS-W8-06a: DENIED outcome cannot upgrade to SUCCESS", () => {
    const deniedRecord = { outcome: "DENIED", probeId: "p-d1", questionRef: "q-1", capabilityId: "cap-1" };
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-d1": deniedRecord }) });
    // Correct DENIED path:
    assert.equal(verifier.verifyCompletion({ probeId: "p-d1", request: { probeId: "p-d1", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "DENIED" }), true);
    // Attempt to upgrade a DENIED probe to SUCCESS:
    const deniedRecord2 = { outcome: "DENIED", probeId: "p-d2", questionRef: "q-1", capabilityId: "cap-1" };
    const verifier2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-d2": deniedRecord2 }) });
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    assert.equal(verifier2.verifyCompletion({ probeId: "p-d2", request: { probeId: "p-d2", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }), false);
});

test("CS-W8-06b: TIMEOUT outcome cannot upgrade to SUCCESS", () => {
    const timedOut = { outcome: "TIMEOUT", probeId: "p-t1", questionRef: "q-1", capabilityId: "cap-1" };
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-t1": timedOut }) });
    assert.equal(verifier.verifyCompletion({ probeId: "p-t1", request: { probeId: "p-t1", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "TIMEOUT" }), true);
    const timedOut2 = { outcome: "TIMEOUT", probeId: "p-t2", questionRef: "q-1", capabilityId: "cap-1" };
    const verifier2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-t2": timedOut2 }) });
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    assert.equal(verifier2.verifyCompletion({ probeId: "p-t2", request: { probeId: "p-t2", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }), false);
});

test("CS-W8-06c: UNCERTAIN PRIOR EFFECT != SAFE TO RETRY — unknown/ambiguous outcome is rejected", () => {
    // The verifier only accepts SUCCESS, DENIED, TIMEOUT. Any other outcome
    // string (AMBIGUOUS, UNKNOWN, PENDING, etc.) that models an uncertain prior
    // effect is rejected fail-closed — it cannot be treated as authorized retry.
    const verifier = createCompletionVerifier({ completionEvidence: () => null });
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    for (const outcome of ["AMBIGUOUS", "UNKNOWN", "PENDING", "EXECUTED_UNVERIFIED", "MAYBE", "PARTIAL"]) {
        assert.equal(
            verifier.verifyCompletion({ probeId: `p-unc-${outcome}`, request: { probeId: `p-unc-${outcome}`, questionRef: "q-1", capabilityId: "cap-1" }, outcome, observation: obs }),
            false,
            `uncertain outcome "${outcome}" must be rejected — not safe to retry as authorized`
        );
    }
});

// ── CS-W8-07: DRIVER SUCCESS != VERIFIED POSTCONDITION ───────────────────

test("CS-W8-07: DRIVER SUCCESS != VERIFIED POSTCONDITION — missing evidence and mismatched postcondition", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    // Case 1: driver claims SUCCESS with no evidence at all.
    const v1 = createCompletionVerifier({ completionEvidence: () => null });
    assert.equal(
        v1.verifyCompletion({ probeId: "p-drv", request: { probeId: "p-drv", questionRef: "q-1", capabilityId: "c-1" }, outcome: "SUCCESS", observation: obs }),
        false, "driver claim without evidence must fail"
    );
    // Case 2: evidence port returns VERIFIED but the observation (postcondition)
    // does not match what canonical execution produced — driver says success but
    // the postcondition cannot be confirmed. Must be rejected.
    const canonObs = { tier: "T4", sensor: { sensorId: "s-canonical" }, frame: { kind: "OFFICE" }, quality: 0.9 };
    const ev = { outcome: "VERIFIED", probeId: "p-drv2", questionRef: "q-1", capabilityId: "c-1", observation: canonObs };
    const v2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-drv2": ev }) });
    const driverObs = { tier: "T4", sensor: { sensorId: "s-driver" }, frame: { kind: "LOBBY" }, quality: 0.7 };
    assert.equal(
        v2.verifyCompletion({ probeId: "p-drv2", request: { probeId: "p-drv2", questionRef: "q-1", capabilityId: "c-1" }, outcome: "SUCCESS", observation: driverObs }),
        false, "mismatched postcondition (driver obs != canonical obs) must fail"
    );
});

// ── CS-W8-08: stale / substituted observation ─────────────────────────────

test("CS-W8-08: forged observation is rejected — caller cannot substitute canonical observation", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    const ev = canonicalEvidence("p-obs", obs);
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-obs": ev }) });
    const forgedObs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.99 };
    assert.equal(
        verifier.verifyCompletion({ probeId: "p-obs", request: { probeId: "p-obs", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: forgedObs }),
        false
    );
});

// ── CS-W8-09: AUTHORIZE and VERIFY always report DEGRADED ────────────────

test("CS-W8-09a: AUTHORIZE and VERIFY always report DEGRADED across a full cycle", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    const reports = {};
    for (let i = 0; i < LOOP_ORDER.length; i++) {
        const r = loop.runCycle();
        reports[r.phase] = r;
        now += 100;
    }
    assert.equal(reports[PHASE.AUTHORIZE].degraded, "AUTHORIZE_UNAVAILABLE");
    assert.equal(reports[PHASE.AUTHORIZE].present, false);
    assert.equal(reports[PHASE.VERIFY].degraded, "VERIFY_UNAVAILABLE");
    assert.equal(reports[PHASE.VERIFY].present, false);
});

test("CS-W8-09b: VERIFY_AUTHORIZE_NEVER_SILENTLY_SKIPPED — both phases present in fixed loop order", () => {
    assert.ok(LOOP_ORDER.includes(PHASE.AUTHORIZE));
    assert.ok(LOOP_ORDER.includes(PHASE.VERIFY));
    const loop = createClosedLoop();
    assert.equal(loop.laws.VERIFY_AUTHORIZE_NEVER_SILENTLY_SKIPPED, true);
});

// ── CS-W8-10: fixed loop order ────────────────────────────────────────────

test("CS-W8-10: canonical 9-phase loop order is enforced across a full cycle", () => {
    assert.equal(LOOP_ORDER.length, 9, "canonical loop must have exactly 9 phases");
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    const phases = [];
    for (let i = 0; i < LOOP_ORDER.length; i++) {
        phases.push(loop.runCycle().phase);
        now += 100;
    }
    assert.deepEqual(phases, LOOP_ORDER);
});

// ── CS-W8-11: loop rate bound ─────────────────────────────────────────────

test("CS-W8-11: busy-spin rejected with LOOP_RATE_EXCEEDED", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    loop.runCycle();
    // Do not advance time — second call within MIN_LOOP_INTERVAL_MS must throw.
    assert.throws(() => loop.runCycle(), (e) => e.reason === "LOOP_RATE_EXCEEDED");
});

// ── CS-W8-12: crash / restart — ephemeral state ───────────────────────────

test("CS-W8-12a: loop state is ephemeral — fresh instance has no phase, no cycle count", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop1 = createClosedLoop({ clock });
    loop1.runCycle(); now += 100;
    loop1.runCycle(); now += 100;
    // Restart: fresh instance must carry no state from loop1.
    now += 100;
    const loop2 = createClosedLoop({ clock });
    assert.equal(loop2.getPhase(), null);
    assert.equal(loop2.getLoopStatus().cycleCount, 0);
    assert.equal(loop2.getLoopStatus().lastAdvanceMs, null);
});

test("CS-W8-12b: verifier state is ephemeral — restart means fresh empty completed set", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    const ev = canonicalEvidence("p-rst", obs);
    const evidence = makeEvidence({ "p-rst": ev });
    const spec = { probeId: "p-rst", request: { probeId: "p-rst", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs };
    const v1 = createCompletionVerifier({ completionEvidence: evidence });
    assert.equal(v1.verifyCompletion(spec), true, "v1 first: accepted");
    assert.equal(v1.verifyCompletion(spec), false, "v1 replay: rejected");
    // New instance (restart): same probe can be verified once again.
    const v2 = createCompletionVerifier({ completionEvidence: evidence });
    assert.equal(v2.verifyCompletion(spec), true, "v2 (restart): fresh state, accepted once");
});

// ── CS-W8-13: partial lane composition degrades honestly ─────────────────

test("CS-W8-13: absent lanes reported as not present — no silent degradation", () => {
    const loop = createClosedLoop(); // all optional lanes absent
    const status = loop.getLoopStatus();
    assert.equal(status.lanesPresent.cycle, false);
    assert.equal(status.lanesPresent.perception, false);
    assert.equal(status.lanesPresent.sensorium, false);
    assert.equal(status.lanesPresent.spatial, false);
    assert.equal(status.lanesPresent.effectors, false);
    assert.equal(status.lanesPresent.simulation, false);
    // Loop still advances — degraded, not dead.
    loop.runCycle();
    assert.notEqual(loop.getPhase(), null);
});

// ── CS-W8-14: no authority escalation — governed requires ledger ──────────

test("CS-W8-14: NO AUTHORITY ESCALATION — core.closedLoop AUTHORIZE always degraded (shadow mode proof)", async () => {
    // Authority-escalation proof: advance the COMPOSED core.closedLoop (not a
    // standalone loop) through all 9 phases and verify AUTHORIZE is
    // AUTHORIZE_UNAVAILABLE. The cognition composition never wires an Authority
    // client into the loop regardless of cognitionMode.
    // Shadow mode is used because it produces a non-null closedLoop with the
    // canonical composition. Governed mode with a test-only ledger may return
    // null (fail-closed), which is separately acceptable but not testable here.
    const core = await createRuntimeCore(cognitionOpts()); // shadow mode
    try {
        assert.ok(core.closedLoop !== null, "shadow mode must produce a closedLoop");
        let authReport = null;
        for (let i = 0; i < LOOP_ORDER.length; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 60)); // ≥ MIN_LOOP_INTERVAL_MS=50
            const r = core.closedLoop.runCycle();
            if (r.phase === PHASE.AUTHORIZE) authReport = r;
        }
        assert.ok(authReport !== null, "AUTHORIZE phase must execute");
        assert.equal(authReport.degraded, "AUTHORIZE_UNAVAILABLE",
            "no cognitionMode must grant a live AUTHORIZE to core.closedLoop");
        assert.equal(authReport.present, false);
    } finally {
        core.shutdown();
    }
});

// ── CS-W8-15: ONE_FRESH_EVALUATION_PER_EFFECT ────────────────────────────

test("CS-W8-15: one-fresh-evaluation law published on every loop instance", () => {
    const loop = createClosedLoop();
    assert.equal(loop.laws.ONE_FRESH_EVALUATION_PER_EFFECT, true);
    assert.equal(loop.laws.NO_SECOND_DISPATCHER, true);
});

// ── CS-W8-16: bidirectional binding strictness ───────────────────────────

test("CS-W8-16a: request without probeId field is rejected (bidirectional binding required)", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    const ev = canonicalEvidence("p-bnd", obs);
    const verifier = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-bnd": ev }) });
    assert.equal(
        verifier.verifyCompletion({ probeId: "p-bnd", request: { questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }),
        false,
        "request.probeId is mandatory for bidirectional binding"
    );
});

test("CS-W8-16b: questionRef/capabilityId mismatch fails closed", () => {
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    const ev = canonicalEvidence("p-mis", obs);
    const v1 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-mis": ev }) });
    assert.equal(v1.verifyCompletion({ probeId: "p-mis", request: { probeId: "p-mis", questionRef: "q-WRONG", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }), false);
    const ev2 = canonicalEvidence("p-mis2", obs);
    const v2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-mis2": ev2 }) });
    assert.equal(v2.verifyCompletion({ probeId: "p-mis2", request: { probeId: "p-mis2", questionRef: "q-1", capabilityId: "cap-WRONG" }, outcome: "SUCCESS", observation: obs }), false);
});

// ── CS-W8-17: known ToolBus skip — status B ──────────────────────────────

test("CS-W8-17: ToolBus skip remains BLOCKED ON W8-IW1 (not resolved by L6/L7)", () => {
    // Status B: the skip requires W8-IW1 production-path harness, which
    // provides canonical capability/actuator registrations. L6/L7 are
    // cognition/composition layers and do NOT provide these registrations.
    const toolBusSrc = fs.readFileSync(
        path.join(ROOT, "tests/wave8/legacy/toolBusAuthority.test.js"), "utf8"
    );
    assert.match(toolBusSrc, /BLOCKED ON W8-IW1/,
        "ToolBus skip must remain annotated as BLOCKED ON W8-IW1");
    // IW1 resolution harness directory must exist.
    assert.ok(
        fs.existsSync(path.join(ROOT, "tests/wave8/iw1")),
        "tests/wave8/iw1 (IW1 resolution harness) must exist"
    );
});

// ── CS-W8-18: runtime core is frozen — no hidden seam attachment ──────────

test("CS-W8-18: createRuntimeCore returns a frozen object (no seam injection after construction)", async () => {
    const core = await createRuntimeCore(cognitionOpts());
    try {
        assert.ok(Object.isFrozen(core), "runtime core must be frozen");
        assert.ok(Object.isFrozen(core.closedLoop), "closedLoop must be frozen");
    } finally {
        core.shutdown();
    }
});

// ── CS-W8-19: CONFIDENCE != AUTHORITY ────────────────────────────────────

test("CS-W8-19: CONFIDENCE != AUTHORITY — high-confidence observation without evidence fails closed", () => {
    // A high-quality or perfectly-confident observation does not constitute
    // authority. The verifier requires canonical execution evidence regardless
    // of the observation's confidence/quality value.
    const verifier = createCompletionVerifier({ completionEvidence: () => null });
    const highConf = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 1.0 };
    assert.equal(
        verifier.verifyCompletion({ probeId: "p-conf-hi", request: { probeId: "p-conf-hi", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: highConf }),
        false, "quality:1.0 without evidence must fail closed"
    );
    // Zero-confidence is also rejected — neither extreme grants authority.
    const zeroConf = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.0 };
    assert.equal(
        verifier.verifyCompletion({ probeId: "p-conf-lo", request: { probeId: "p-conf-lo", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: zeroConf }),
        false, "quality:0.0 without evidence must fail closed"
    );
    // OBSERVATION != AUTHORITY: even a maximally-structured observation with all
    // canonical fields populated is not itself evidence of authority.
    const maxObs = { tier: "T4", sensor: { sensorId: "s-canonical" }, frame: { kind: "ROOM" }, quality: 0.95 };
    const ev = canonicalEvidence("p-obs-max", maxObs);
    const verifier2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-obs-max": ev }) });
    // Right observation + right evidence: accepted once.
    assert.equal(
        verifier2.verifyCompletion({ probeId: "p-obs-max", request: { probeId: "p-obs-max", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: maxObs }),
        true, "canonical evidence with matching observation must be accepted"
    );
    // Same observation + no evidence: rejected.
    const verifier3 = createCompletionVerifier({ completionEvidence: () => null });
    assert.equal(
        verifier3.verifyCompletion({ probeId: "p-obs-max2", request: { probeId: "p-obs-max2", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: maxObs }),
        false, "same observation without evidence must be rejected"
    );
});

// ── CS-W8-21: CAPABILITY AVAILABLE != AUTHORITY ──────────────────────────

test("CS-W8-21: CAPABILITY AVAILABLE != AUTHORITY — verifier accepts no capabilityRegistry, availability irrelevant", () => {
    // Structural proof: createCompletionVerifier does NOT accept a
    // capabilityRegistry option. Capability availability is structurally
    // excluded from the authorization path — the verifier only accepts
    // completionEvidence and bounds. Any capability, AVAILABLE or not,
    // requires canonical execution evidence.
    const verifierSrc = fs.readFileSync(path.join(ROOT, "src/cognition/closedloop/index.js"), "utf8");
    assert.doesNotMatch(verifierSrc, /capabilityRegistry/,
        "createCompletionVerifier must not accept a capabilityRegistry — availability is not authority");
    // Runtime proof: probes for any capabilityId string fail when port returns null.
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.9 };
    for (const capId of ["cap-available", "cap-AVAILABLE", "CERTIFIED_CAPABILITY", "always-ready"]) {
        const v = createCompletionVerifier({ completionEvidence: () => null });
        assert.equal(
            v.verifyCompletion({ probeId: `p-${capId}`, request: { probeId: `p-${capId}`, questionRef: "q-1", capabilityId: capId }, outcome: "SUCCESS", observation: obs }),
            false, `capability "${capId}" without canonical evidence must fail regardless of availability`
        );
    }
});

// ── CS-W8-22: MODEL OUTPUT != AUTHORITY ──────────────────────────────────

test("CS-W8-22: MODEL OUTPUT != AUTHORITY — model-constructed evidence shape blocked by null port", () => {
    // The canonical completionEvidence port is fixed to () => null at
    // composition time. Even if a model could construct a perfectly-shaped
    // evidence object (correct probeId, questionRef, capabilityId, outcome,
    // observation), that construction cannot bypass the port. The verifier
    // consumes ONLY what the port returns; model output has no pathway in.
    const verifier = createCompletionVerifier({ completionEvidence: () => null });
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.95 };
    // Perfectly-shaped model-constructed "evidence" — correct in every field.
    // The port returns null regardless, so this must fail.
    assert.equal(
        verifier.verifyCompletion({ probeId: "p-model", request: { probeId: "p-model", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }),
        false, "model-constructed evidence shape cannot bypass the null port"
    );
    // Verify the port is the sole trust input: with a real port, same shape succeeds.
    const ev = canonicalEvidence("p-model2", obs);
    const verifier2 = createCompletionVerifier({ completionEvidence: makeEvidence({ "p-model2": ev }) });
    assert.equal(
        verifier2.verifyCompletion({ probeId: "p-model2", request: { probeId: "p-model2", questionRef: "q-1", capabilityId: "cap-1" }, outcome: "SUCCESS", observation: obs }),
        true, "canonical port producing correct evidence must be accepted — port is the only trust input"
    );
});

// ── CS-W8-20: FSYNC FILE != DIRECTORY ENTRY DURABLE ──────────────────────

test("CS-W8-20: FSYNC FILE != DIRECTORY ENTRY DURABLE — dual-witness test asserts REPLAY_HEAD_UNWITNESSED", () => {
    // The invariant: fsyncing a file does not guarantee its directory entry
    // survives a crash. The dual-witness test enforces this: the local anchor
    // must NOT substitute for the external witness (line: assert.match(String(...),
    // /REPLAY_HEAD_UNWITNESSED/)).
    // This test checks for the actual assertion call, not just the word in a comment.
    const witnessTest = path.join(ROOT, "tests/wave8/iw1/replayDualWitness.test.js");
    assert.ok(fs.existsSync(witnessTest), "replayDualWitness.test.js must exist");
    const src = fs.readFileSync(witnessTest, "utf8");
    // Verify REPLAY_HEAD_UNWITNESSED appears on a line that ALSO contains an assert call.
    // This proves it is a live assertion, not just a comment or string constant.
    const lines = src.split(/\r?\n/);
    // Verify REPLAY_HEAD_UNWITNESSED appears as a REGEX LITERAL being matched in an assert.
    // This prevents a vacuous pass from assert.ok(true, "REPLAY_HEAD_UNWITNESSED") which
    // would contain the string but not test the invariant.
    const hasRegexAssertion = lines.some(line =>
        /assert\.\w+/.test(line) && /\/REPLAY_HEAD_UNWITNESSED\//.test(line)
    );
    assert.ok(hasRegexAssertion,
        "dual-witness test must contain assert.*(/.../REPLAY_HEAD_UNWITNESSED/...) — regex-as-assertion pattern");
});
