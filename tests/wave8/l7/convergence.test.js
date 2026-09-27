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
        // Symbol-keyed seams are also prohibited — no symbol-keyed seam can serve as an admission path.
        assert.equal(Object.getOwnPropertySymbols(core.closedLoop).length, 0,
            "closedLoop must have no symbol-keyed properties that could be admission seams");
    } finally {
        core.shutdown();
    }
});

test("CS-W8-03b: TOOL != AUTHORITY — closedloop imports nothing from action or authority (path-exhaustive)", () => {
    // Scan ALL closedloop source files (index.js + helpers) — a forbidden import in
    // phases.js, laws.js, bounds.js, etc. is equally prohibited.
    const closedloopDir = path.join(ROOT, "src/cognition/closedloop");
    const closedloopFiles = fs.readdirSync(closedloopDir)
        .filter(f => f.endsWith(".js"))
        .map(f => path.join(closedloopDir, f));
    for (const file of closedloopFiles) {
        const rawSrc = fs.readFileSync(file, "utf8");
        const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
        const relPath = path.relative(ROOT, file).replace(/\\/g, "/");
        // Enumerate ALL string-literal require() calls; normalize backslashes.
        const deps = [...src.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map(m => m[1]);
        for (const dep of deps) {
            const norm = dep.replace(/\\/g, "/");
            assert.ok(!/\/action(\/|$)/.test(norm),
                `[${relPath}] closedloop must not require "${dep}" (action module)`);
            assert.ok(!/\/authority(\/|$)/.test(norm),
                `[${relPath}] closedloop must not require "${dep}" (authority module)`);
            assert.ok(!norm.includes("actuator"),
                `[${relPath}] closedloop must not require "${dep}" (actuator module)`);
        }
        // No dynamic require() calls.
        const dynamicRequires = src.match(/\brequire\s*\(\s*[^"'`\s)]/g);
        assert.equal(dynamicRequires, null,
            `[${relPath}] closedloop must not use dynamic require() calls`);
        // No template literal require().
        const templateLitRequires = rawSrc.match(/\brequire\s*\(\s*`/g);
        assert.equal(templateLitRequires, null,
            `[${relPath}] closedloop must not use template literal require()`);
        // No module.require().
        const moduleRequires = src.match(/\bmodule\.require\s*\(/g);
        assert.equal(moduleRequires, null,
            `[${relPath}] closedloop must not use module.require()`);
        // No eval().
        assert.doesNotMatch(src, /\beval\s*\(/, `[${relPath}] closedloop must not use eval()`);
        // No require() aliasing — const load = require (without call parens) assigns the function itself.
        assert.doesNotMatch(src, /(?:const|let|var)\s+\w+\s*=\s*\brequire\b(?!\s*\()/,
            `[${relPath}] closedloop must not alias require into another variable`);
    }
});

test("CS-W8-03c: NO_SECOND_DISPATCHER — no dispatch() call inside closedloop", () => {
    assert.equal(laws.NO_SECOND_DISPATCHER, true);
    // Strip comments before scanning so aliased call via /* comment */ tricks are excluded.
    const rawSrc = fs.readFileSync(path.join(ROOT, "src/cognition/closedloop/index.js"), "utf8");
    const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    assert.doesNotMatch(src, /\bdispatch\s*\(/, "closedloop must not call dispatch()");
    assert.doesNotMatch(src, /createDispatch/, "closedloop must not create a dispatcher");
    // Optional-chaining invocation: dispatch?.()
    assert.doesNotMatch(src, /\bdispatch\s*\?\.\s*\(/, "closedloop must not call dispatch?.()");
    // Method invocation forms: dispatch.call(...) and dispatch.apply(...)
    assert.doesNotMatch(src, /\bdispatch\s*\.call\s*\(/, "closedloop must not call dispatch.call(...)");
    assert.doesNotMatch(src, /\bdispatch\s*\.apply\s*\(/, "closedloop must not call dispatch.apply(...)");
    // Bound call: dispatch.bind(...)(...)
    assert.doesNotMatch(src, /\bdispatch\s*\.bind\s*\(/, "closedloop must not call dispatch.bind(...)");
    // Indirect invocation via Reflect.apply(dispatch, ...) is also prohibited.
    assert.doesNotMatch(src, /Reflect\.apply\s*\([^,]*dispatch/,
        "closedloop must not invoke dispatch via Reflect.apply");
    // No eval() — eval can alias and invoke dispatch at runtime.
    assert.doesNotMatch(src, /\beval\s*\(/, "closedloop must not use eval()");
    // No dispatch variable aliasing — const/let/var alias = dispatch binds a callable alias.
    assert.doesNotMatch(src, /(?:const|let|var)\s+\w+\s*=\s*\bdispatch\b/,
        "closedloop must not alias dispatch into another variable");
});

// ── CS-W8-04: PERCEPTION != AUTHORITY — L2 probe scheduling ──────────────

test("CS-W8-04a: PERCEPTION != AUTHORITY — every dispatch: line in all perception modules is null", () => {
    // Scan ALL perception source files, not just index.js, so a helper module
    // cannot wire a non-null dispatcher that index.js then re-exports.
    const perceptionDir = path.join(ROOT, "src/cognition/perception");
    const perceptionFiles = fs.readdirSync(perceptionDir)
        .filter(f => f.endsWith(".js"))
        .map(f => path.join(perceptionDir, f));
    // Verify no subdirectories exist — the flat scan above is exhaustive only if
    // the perception module has no nested sub-packages.
    const allEntries = fs.readdirSync(perceptionDir, { withFileTypes: true });
    const subdirs = allEntries.filter(e => e.isDirectory());
    assert.equal(subdirs.length, 0,
        "perception dir must have no subdirectories (scan is flat — add recursion if subdirs appear)");
    for (const file of perceptionFiles) {
        // Strip comments before analysis so comment-masked patterns are not missed.
        const rawSrc = fs.readFileSync(file, "utf8");
        const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
        const relPath = path.relative(ROOT, file).replace(/\\/g, "/");
        // Every dispatch: key must be null.
        const dispatchLines = src.split("\n").filter(l => /\bdispatch\s*:/.test(l));
        for (const line of dispatchLines) {
            assert.match(line, /\bdispatch\s*:\s*null\b/,
                `[${relPath}] dispatch: assignment must be null — offending line: ${line.trim()}`);
        }
        // No dot or bracket dynamic assignment to dispatch (double-quoted OR single-quoted key).
        const dynamicDispatchLines = src.split("\n").filter(l =>
            (/\.dispatch\s*=/.test(l) && !/\.dispatch\s*=\s*null\b/.test(l)) ||
            (/\["dispatch"\]\s*=/.test(l) && !/\["dispatch"\]\s*=\s*null\b/.test(l)) ||
            (/\['dispatch'\]\s*=/.test(l) && !/\['dispatch'\]\s*=\s*null\b/.test(l))
        );
        assert.equal(dynamicDispatchLines.length, 0,
            `[${relPath}] no non-null dynamic dispatch assignment: ${dynamicDispatchLines.join("; ")}`);
        // No Object.assign spreading dispatch non-null.
        assert.doesNotMatch(src, /Object\.assign\s*\([^)]*[{,]\s*dispatch\s*:/,
            `[${relPath}] Object.assign must not spread a dispatch key`);
        // No Object.defineProperties assigning dispatch.
        assert.doesNotMatch(src, /Object\.defineProperties\s*\([^,]+,\s*\{[^}]*dispatch\s*:/,
            `[${relPath}] Object.defineProperties must not define dispatch`);
        // No string concatenation constructing "dispatch" from parts.
        assert.doesNotMatch(rawSrc, /["']dis["']\s*\+\s*["']patch["']/,
            `[${relPath}] must not construct "dispatch" key by string concatenation`);
        // No dynamic require() calls.
        const dynReq = src.match(/\brequire\s*\(\s*[^"'`\s)]/g);
        assert.equal(dynReq, null, `[${relPath}] perception must not use dynamic require()`);
        // No Object.defineProperty or Reflect.set targeting dispatch.
        assert.doesNotMatch(src, /Object\.defineProperty\s*\([^,]+,\s*["']dispatch["']/,
            `[${relPath}] Object.defineProperty must not define dispatch`);
        assert.doesNotMatch(src, /Reflect\.(set|defineProperty)\s*\([^,]+,\s*["']dispatch["']/,
            `[${relPath}] Reflect must not set dispatch`);
        // No dispatcher import.
        assert.doesNotMatch(src, /require\s*\(\s*["'][^"']*\/dispatch/,
            `[${relPath}] perception module must not import a dispatcher`);
    }
    // The canonical index.js must contain at least one dispatch: null wiring.
    const indexRaw = fs.readFileSync(path.join(perceptionDir, "index.js"), "utf8");
    const indexSrc = indexRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    const indexDispatchLines = indexSrc.split("\n").filter(l => /\bdispatch\s*:/.test(l));
    assert.ok(indexDispatchLines.length > 0,
        "perception/index.js must contain at least one dispatch: wiring");
});

test("CS-W8-04b: L2-L6 completion path is fail-closed without canonical execution evidence", () => {
    // Structural: canonicalRuntimeComposition.js must hard-wire completionEvidence = () => null
    // as a const binding AND pass it by shorthand to createCompletionVerifier — proving live wiring,
    // not a dead declaration that precedes an unrelated call.
    const compositionRaw = fs.readFileSync(
        path.join(ROOT, "src/integration/canonicalRuntimeComposition.js"), "utf8"
    );
    const compositionSrc = compositionRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    // Binding: const completionEvidence = () => null
    assert.match(compositionSrc, /const\s+completionEvidence\s*=\s*\(\s*\)\s*=>\s*null/,
        "completionEvidence must be declared as a const () => null binding");
    // Shorthand passing: completionEvidence must appear WITHOUT a colon (shorthand property).
    // { completionEvidence } is shorthand — proves the null binding is what's passed.
    // { completionEvidence: expr } would bypass this by passing a different expression.
    assert.match(compositionSrc, /createCompletionVerifier\s*\(\s*\{[^}]*\bcompletionEvidence\s*[,}]/,
        "createCompletionVerifier must receive completionEvidence as shorthand property (no colon)");
    assert.doesNotMatch(compositionSrc, /createCompletionVerifier\s*\(\s*\{[^}]*\bcompletionEvidence\s*:/,
        "createCompletionVerifier must NOT use completionEvidence: expr — shorthand only proves null binding");
    // Proximity: null binding must appear within 400 chars before the call (same scope block)
    assert.match(compositionSrc,
        /completionEvidence\s*=\s*\(\s*\)\s*=>\s*null[\s\S]{0,400}createCompletionVerifier/,
        "completionEvidence = () => null must appear within 400 chars before createCompletionVerifier");
    // Runtime: the null port produces fail-closed verification.
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
    // Use getOwnPropertyNames to catch non-enumerable seams that Object.keys misses.
    const surface = Object.getOwnPropertyNames(verifier).filter(k => k !== "__proto__");
    assert.deepEqual(surface.sort(), ["verifyCompletion"],
        "verifier must expose exactly verifyCompletion — no cache-read or mint surface (including non-enumerable)");
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

test("CS-W8-06c: UNCERTAIN PRIOR EFFECT != SAFE TO RETRY — unknown/ambiguous outcome rejected even with evidence", () => {
    // The verifier only accepts SUCCESS, DENIED, TIMEOUT. Any other outcome
    // string (AMBIGUOUS, UNKNOWN, PENDING, etc.) must be rejected even when
    // canonical evidence IS available — the outcome-type gate must be exercised,
    // not just the null-evidence short-circuit.
    const obs = { tier: "T4", sensor: { sensorId: "s-1" }, frame: { kind: "ROOM" }, quality: 0.8 };
    for (const outcome of ["AMBIGUOUS", "UNKNOWN", "PENDING", "EXECUTED_UNVERIFIED", "MAYBE", "PARTIAL"]) {
        const probeId = `p-unc-${outcome}`;
        // Provide canonical evidence that WOULD satisfy a SUCCESS probe — so
        // rejection must come from the outcome-type check, not null evidence.
        const ev = canonicalEvidence(probeId, obs);
        const v = createCompletionVerifier({ completionEvidence: makeEvidence({ [probeId]: ev }) });
        assert.equal(
            v.verifyCompletion({ probeId, request: { probeId, questionRef: "q-1", capabilityId: "cap-1" }, outcome, observation: obs }),
            false,
            `uncertain outcome "${outcome}" must be rejected by outcome-type check even when evidence is present`
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
    // Independent canonical array from W8_EMBODIMENT_CONTRACT.md §5 — not derived
    // from the LOOP_ORDER export, so a corrupted export does not self-certify.
    const CANONICAL_ORDER = [
        "OBSERVE", "INTERPRET", "PREDICT", "PLAN", "AUTHORIZE",
        "ACT", "OBSERVE_EFFECT", "VERIFY", "UPDATE"
    ];
    assert.equal(LOOP_ORDER.length, 9, "canonical loop must have exactly 9 phases");
    assert.deepEqual([...LOOP_ORDER], CANONICAL_ORDER,
        "exported LOOP_ORDER must match the frozen contract order");
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    const phases = [];
    for (let i = 0; i < CANONICAL_ORDER.length; i++) {
        phases.push(loop.runCycle().phase);
        now += 100;
    }
    assert.deepEqual(phases, CANONICAL_ORDER);
});

// ── CS-W8-11: loop rate bound ─────────────────────────────────────────────

test("CS-W8-11: busy-spin rejected with LOOP_RATE_EXCEEDED — boundary exact", () => {
    let now = 0;
    const clock = { nowMs: () => now };
    const loop = createClosedLoop({ clock });
    loop.runCycle();
    // elapsed=0: well under boundary — must reject.
    assert.throws(() => loop.runCycle(), (e) => e.reason === "LOOP_RATE_EXCEEDED",
        "elapsed=0 must be rejected (< MIN_LOOP_INTERVAL_MS)");
    // elapsed = MIN_LOOP_INTERVAL_MS - 1: one tick under — must still reject.
    now = BOUNDS.MIN_LOOP_INTERVAL_MS - 1;
    assert.throws(() => loop.runCycle(), (e) => e.reason === "LOOP_RATE_EXCEEDED",
        "elapsed=MIN_LOOP_INTERVAL_MS-1 must be rejected (boundary exclusive)");
    // elapsed = MIN_LOOP_INTERVAL_MS: at boundary — must be accepted.
    now = BOUNDS.MIN_LOOP_INTERVAL_MS;
    assert.doesNotThrow(() => loop.runCycle(),
        "elapsed=MIN_LOOP_INTERVAL_MS must be accepted (at boundary)");
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
    const report = loop.runCycle();
    assert.notEqual(loop.getPhase(), null);
    // Phase report must have a boolean present field — no silent omission.
    assert.equal(typeof report.present, "boolean",
        "each phase report must declare present as a boolean (no silent degradation)");
});

// ── CS-W8-14: no authority escalation — governed requires ledger ──────────

test("CS-W8-14: NO AUTHORITY ESCALATION — core.closedLoop AUTHORIZE always degraded (shadow + governed proof)", async () => {
    // Authority-escalation proof: advance the COMPOSED core.closedLoop through all
    // 9 phases and verify AUTHORIZE is AUTHORIZE_UNAVAILABLE in shadow mode.
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
    // Governed mode: closedLoop must be null (fail-closed) OR also have degraded AUTHORIZE.
    const governedCore = await createRuntimeCore(cognitionOpts({ cognitionMode: "governed" }));
    try {
        if (governedCore.closedLoop !== null) {
            let govAuthReport = null;
            for (let i = 0; i < LOOP_ORDER.length; i++) {
                if (i > 0) await new Promise(r => setTimeout(r, 60));
                const r = governedCore.closedLoop.runCycle();
                if (r.phase === PHASE.AUTHORIZE) govAuthReport = r;
            }
            assert.ok(govAuthReport !== null, "governed AUTHORIZE phase must execute if closedLoop is non-null");
            assert.equal(govAuthReport.degraded, "AUTHORIZE_UNAVAILABLE",
                "governed mode must not grant a live AUTHORIZE to core.closedLoop");
        }
        // null closedLoop is also acceptable (fail-closed governed mode)
    } finally {
        governedCore.shutdown();
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
    // The annotation must appear as the value of a skip: property on a test that references ToolBus.
    // Verify: a skip: property containing BLOCKED ON W8-IW1 appears near "toolBus" or "ToolBus".
    assert.match(toolBusSrc, /skip\s*:\s*["'][^"']*BLOCKED ON W8-IW1/,
        "ToolBus skip must be a live skip: property value, not just a comment");
    // The skipped test must reference the ToolBus domain (not an unrelated test carrying the annotation).
    const toolBusLines = toolBusSrc.split(/\r?\n/);
    const skipIdx = toolBusLines.findIndex(l => /skip\s*:\s*["'][^"']*BLOCKED ON W8-IW1/.test(l));
    assert.ok(skipIdx >= 0, "skip: BLOCKED ON W8-IW1 line must exist");
    const surroundCtx = toolBusLines.slice(Math.max(0, skipIdx - 10), skipIdx + 10).join("\n");
    assert.match(surroundCtx, /[Tt]ool\s*[Bb]us|TOOL_BUS|toolBus/,
        "skip: BLOCKED ON W8-IW1 must appear in the context of a ToolBus test");
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
    // Verify REPLAY_HEAD_UNWITNESSED appears in a POSITIVE assertion (assert.match or
    // assert.rejects) as a regex literal. This excludes assert.doesNotMatch and
    // assert.ok(true, "REPLAY_HEAD_UNWITNESSED") which would vacuously pass.
    const assertionLine = lines.find(line =>
        /(assert\.match|assert\.rejects)/.test(line) && /\/REPLAY_HEAD_UNWITNESSED\//.test(line)
    );
    assert.ok(assertionLine !== undefined,
        "dual-witness test must contain assert.match or assert.rejects with /REPLAY_HEAD_UNWITNESSED/ — positive durability assertion");
    // Non-vacuous: the assertion must apply to a real system, not a self-fulfilling
    // Promise.reject() or inline new Error() that trivially matches the pattern.
    assert.doesNotMatch(assertionLine, /Promise\.reject\s*\(/,
        "REPLAY_HEAD_UNWITNESSED assertion must not be self-fulfilling via Promise.reject");
    assert.doesNotMatch(assertionLine, /new\s+Error\s*\(/,
        "REPLAY_HEAD_UNWITNESSED assertion must not be self-fulfilling via inline new Error");
    // File must import the real replay ledger module, not just contain error strings.
    assert.match(src, /require\s*\([^)]*canonicalReplayLedger/,
        "dual-witness test must import canonicalReplayLedger (the system under test)");
    // The assertion must appear after a real ledger.reserve() call that produced an error,
    // not as an isolated decoy. Verify: a ledger.reserve call precedes it AND an error is
    // caught/captured before the assertion.
    const assertLineIdx = lines.findIndex(line =>
        /(assert\.match|assert\.rejects)/.test(line) && /\/REPLAY_HEAD_UNWITNESSED\//.test(line)
    );
    const context = lines.slice(Math.max(0, assertLineIdx - 12), assertLineIdx + 1).join("\n");
    assert.match(context, /ledger\.(reserve|commit|rollback)/,
        "REPLAY_HEAD_UNWITNESSED assertion must appear after a ledger.reserve/commit/rollback call");
    // Error must be caught and then tested — either via try/catch or assert.rejects with real async call.
    // A pre-seeded err variable cannot satisfy both an error-init pattern AND a try block.
    const hasTryCatch = /\btry\s*\{[\s\S]*?catch\s*\(/.test(context) ||
        /(err|e|error)\s*=\s*null[\s\S]{0,100}try\s*\{/.test(context);
    const hasSingleRejects = /assert\.rejects\s*\(\s*(?:async\s*)?\(\s*\)/.test(context);
    assert.ok(hasTryCatch || hasSingleRejects,
        "REPLAY_HEAD_UNWITNESSED must be tested via try/catch or assert.rejects — not a pre-seeded error");
});
