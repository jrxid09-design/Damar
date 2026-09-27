"use strict";

/**
 * W8-L6 CLOSED-LOOP PERCEPTION-ACTION — composition only, no domain state.
 *
 * Composes the W7 cycle plus the W8-L1..L5 lanes into a bounded loop and — the
 * piece the earlier embodied lanes depend on — supplies the trusted completion
 * verifier that closes the W8-L2 active-perception handoff. It never
 * dispatches, never evaluates Authority, never touches an actuator.
 *
 * The loop order is fixed (see phases.js). A missing stage SHORTENS the loop
 * honestly; AUTHORIZE and VERIFY are never silently skipped — they always
 * report DEGRADED when their canonical inputs (an authorized intent, and
 * verification evidence) are absent, never a pretend authorization or a
 * pretend verified postcondition.
 *
 * HARD BOUNDARY: this module imports NOTHING from src/action/** or
 * src/authority/**. The trusted completion grounding (canonical execution
 * evidence) is composed OUTSIDE this module, inside the canonical runtime
 * composition, and injected as the `completionEvidence` port. This module
 * itself is incapable of declaring any probe complete.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { PHASE, LOOP_ORDER } = require("./phases");
const utilTypes = require("node:util").types;
const IS_PROXY = utilTypes.isProxy;

function resolveMethod(port, name) {
    if (!port || (typeof port !== "object" && typeof port !== "function") || IS_PROXY(port)) return null;
    let at = port;
    const seen = new Set();
    while (at && (typeof at === "object" || typeof at === "function")) {
        if (at === Object.prototype || at === Function.prototype) break;
        if (seen.has(at)) break;
        seen.add(at);
        if (IS_PROXY(at)) return null;
        let desc;
        try { desc = Object.getOwnPropertyDescriptor(at, name); } catch { return null; }
        if (desc) return !desc.get && !desc.set && typeof desc.value === "function" ? desc.value : null;
        try { at = Object.getPrototypeOf(at); } catch { return null; }
    }
    return null;
}

function safeNowMs(clock) {
    let t;
    try { const fn = safeData(clock, "nowMs"); t = typeof fn === "function" && !IS_PROXY(fn) ? fn.call(clock) : undefined; } catch { t = undefined; }
    return Number.isFinite(t) ? t : Date.now();
}

function safeData(value, key) {
    if (!value || (typeof value !== "object" && typeof value !== "function") || IS_PROXY(value)) return undefined;
    try {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return d && !d.get && !d.set ? d.value : undefined;
    } catch { return undefined; }
}

function sanitizeBounds(bounds) {
    const out = {};
    for (const key of Object.keys(BOUNDS)) {
        const v = safeData(bounds, key);
        out[key] = typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : BOUNDS[key];
    }
    return Object.freeze(out);
}

/**
 * Defensive deep equality. Reads every property by data descriptor only (all
 * own properties, including non-enumerable), checks array/prototype identity,
 * and rejects accessors. A hostile observation (accessor, Proxy, Symbol key,
 * or cyclic object) never makes the verifier throw — it is treated as "not
 * equal", so `verifyCompletion` returns false fail-closed. This closes the
 * check-then-use race: the verifier enumerates the same properties (all own,
 * including non-enumerable) that safeClone copies, so what the verifier checks
 * IS what the L2 lane stores.
 */
function readDataDeep(value, key) {
    if (value === null || typeof value !== "object" || IS_PROXY(value)) return { ok: false };
    let d;
    try { d = Object.getOwnPropertyDescriptor(value, key); } catch { return { ok: false }; }
    if (!d || d.get || d.set || !("value" in d)) return { ok: false };
    return { ok: true, value: d.value, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable };
}

function deepEqual(a, b, depth = 0) {
    if (depth > 32) return false;
    if (IS_PROXY(a) || IS_PROXY(b)) return false;
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    let protoA, protoB;
    try { protoA = Object.getPrototypeOf(a); protoB = Object.getPrototypeOf(b); } catch { return false; }
    if (protoA !== protoB) return false;
    let ka, kb;
    try {
        ka = Reflect.ownKeys(a);
        kb = Reflect.ownKeys(b);
    } catch { return false; }
    if (ka.length !== kb.length) return false;
    const kbSet = new Set(kb);
    for (const k of ka) {
        if (!kbSet.has(k)) return false;
        const ra = readDataDeep(a, k);
        const rb = readDataDeep(b, k);
        if (!ra.ok || !rb.ok) return false;
        if (ra.writable !== rb.writable || ra.enumerable !== rb.enumerable || ra.configurable !== rb.configurable) return false;
        if (!deepEqual(ra.value, rb.value, depth + 1)) return false;
    }
    return true;
}

/**
 * The trusted completion verifier for the W8-L2 handoff. Synchronous and
 * composition-owned. A probe is complete ONLY when the injected
 * `completionEvidence` port returns a canonical completion bound to the exact
 * probe, and the caller's observation matches that completion's observation
 * (a caller may not substitute a forged observation for the one canonical
 * execution produced). Returns false on every hostile/forged input — it never
 * throws to the caller.
 */
function createCompletionVerifier(opts = {}) {
    const completionEvidence = safeData(opts, "completionEvidence");
    const boundsInput = safeData(opts, "bounds") ?? BOUNDS;
    if (typeof completionEvidence !== "function" || IS_PROXY(completionEvidence)) {
        throw new TypeError("completion verifier requires a completionEvidence port");
    }
    let maxRecords;
    try { maxRecords = boundsInput && boundsInput.MAX_COMPLETION_RECORDS; } catch { maxRecords = null; }
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) maxRecords = BOUNDS.MAX_COMPLETION_RECORDS;

    const completed = new Set();

    function verifyCompletion(spec) {
        try {
            return verifyCompletionGuarded(spec);
        } catch {
            return false;
        }
    }

    function verifyCompletionGuarded(spec) {
        if (!spec || (typeof spec !== "object") || IS_PROXY(spec)) return false;
        const probeId = safeData(spec, "probeId");
        const request = safeData(spec, "request");
        const outcome = safeData(spec, "outcome");
        const observation = safeData(spec, "observation");
        if (typeof probeId !== "string" || probeId.length === 0) return false;
        if (!request || (typeof request !== "object") || IS_PROXY(request)) return false;

        // Duplicate completion cannot charge or complete twice.
        if (completed.has(probeId)) return false;

        const evProbeId = safeData(request, "probeId");
        const evQuestionRef = safeData(request, "questionRef");
        const evCapabilityId = safeData(request, "capabilityId");

        let evidence;
        try {
            evidence = completionEvidence({ probeId, request, outcome, observation });
        } catch {
            return false;
        }
        if (!evidence || (typeof evidence !== "object") || IS_PROXY(evidence)) return false;

        const evOutcome = safeData(evidence, "outcome");
        const eProbeId = safeData(evidence, "probeId");
        const eQuestionRef = safeData(evidence, "questionRef");
        const eCapabilityId = safeData(evidence, "capabilityId");

        // The completion must be bound to the exact probe. Evidence must carry
        // explicit non-undefined questionRef/capabilityId (canonical evidence
        // always does). Binding is then enforced bidirectionally.
        if (eProbeId !== probeId) return false;
        if (evProbeId !== undefined && evProbeId !== probeId) return false;
        if (eQuestionRef === undefined || eCapabilityId === undefined) return false;
        if (eQuestionRef !== evQuestionRef) return false;
        if (eCapabilityId !== evCapabilityId) return false;

        if (outcome === "SUCCESS") {
            if (evOutcome !== "VERIFIED") return false;
            // A successful result must be the SAME observation canonical
            // execution produced — a caller may not substitute its own.
            const evObservation = safeData(evidence, "observation");
            if (evObservation === undefined) return false;
            if (!deepEqual(evObservation, observation)) return false;
        } else if (outcome === "DENIED") {
            if (evOutcome !== "DENIED") return false;
        } else if (outcome === "TIMEOUT") {
            if (evOutcome !== "TIMEOUT") return false;
        } else {
            return false;
        }

        if (completed.size >= maxRecords) return false;
        completed.add(probeId);
        return true;
    }

    return Object.freeze({ verifyCompletion });
}

/**
 * Compose the closed loop over the W7 cycle and the W8-L1..L5 lanes.
 * Composition only: no dispatch, no Authority evaluation, no actuator handle,
 * no domain state. Loop state is ephemeral (never recovered after restart).
 */
function createClosedLoop(opts = {}) {
    const cycle = safeData(opts, "cycle") ?? null;
    const perceptionLane = safeData(opts, "perceptionLane") ?? null;
    const sensoriumBridge = safeData(opts, "sensoriumBridge") ?? null;
    const spatial = safeData(opts, "spatial") ?? null;
    const effectors = safeData(opts, "effectors") ?? null;
    const simulation = safeData(opts, "simulation") ?? null;
    const auditLedger = safeData(opts, "auditLedger") ?? null;
    const clock = safeData(opts, "clock") ?? { nowMs: () => Date.now() };
    const bounds = safeData(opts, "bounds") ?? BOUNDS;
    let safeBounds;
    try { safeBounds = sanitizeBounds(bounds); } catch { safeBounds = BOUNDS; }

    function audit(eventType, fields) {
        try {
            const append = resolveMethod(auditLedger, "append");
            if (append) {
                Reflect.apply(append, auditLedger, [Object.freeze({
                    eventType, source: "acc.closedloop", outcome: "ok",
                    metadata: Object.freeze({ lane: "W8-L6", ...fields })
                })]);
            }
        } catch { /* audit failure never blocks the loop */ }
    }

    const lanesPresent = Object.freeze({
        cycle: cycle != null,
        perception: perceptionLane != null,
        sensorium: sensoriumBridge != null,
        spatial: spatial != null,
        effectors: effectors != null,
        simulation: simulation != null
    });

    let currentPhase = null;
    let cycleCount = 0;
    let lastAdvanceMs = null;
    let degraded = [];

    function observeStage() {
        const report = { phase: PHASE.OBSERVE, present: true };
        if (sensoriumBridge) {
            const obs = safeData(sensoriumBridge, "observability");
            const pending = obs ? safeData(obs, "pendingObservations") : undefined;
            const inFlight = obs ? safeData(obs, "inFlightObservations") : undefined;
            report.pendingObservations = Number.isSafeInteger(pending) ? pending : null;
            report.inFlightObservations = Number.isSafeInteger(inFlight) ? inFlight : null;
        } else {
            report.present = false;
        }
        if (perceptionLane) {
            const counts = safeData(perceptionLane, "probeCounts");
            report.openQuestions = counts ? safeData(counts, "questions") : null;
        }
        return report;
    }

    function interpretStage() {
        const report = { phase: PHASE.INTERPRET, present: true };
        let contradictions = null;
        if (cycle) {
            const lanes = safeData(cycle, "lanes");
            const worldModel = lanes ? safeData(lanes, "worldModel") : null;
            const fn = resolveMethod(worldModel, "openContradictions");
            if (fn) {
                try { const c = Reflect.apply(fn, worldModel, []); contradictions = Array.isArray(c) ? c.length : null; } catch { contradictions = null; }
            }
        }
        report.openContradictions = contradictions;
        if (contradictions === null) report.present = false;
        return report;
    }

    function predictStage() {
        const report = { phase: PHASE.PREDICT, present: true };
        if (!simulation) { report.present = false; return report; }
        const fn = resolveMethod(simulation, "listRuns");
        if (!fn) { report.present = false; return report; }
        try {
            const runs = Reflect.apply(fn, simulation, []);
            report.retainedRuns = Array.isArray(runs) ? runs.length : null;
        } catch { report.retainedRuns = null; report.present = false; }
        return report;
    }

    function planStage() {
        const report = { phase: PHASE.PLAN, present: true };
        if (!cycle) { report.present = false; return report; }
        const lanes = safeData(cycle, "lanes");
        const prospective = lanes ? safeData(lanes, "prospective") : null;
        if (!prospective) { report.present = false; return report; }
        return report;
    }

    // AUTHORIZE and VERIFY are the loop's two safety-critical stages. This
    // lane has no Authority client and no verifier of its own: it can only
    // REPORT them as DEGRADED when no canonical authorized-intent / verification
    // evidence is supplied — it never pretends they succeeded.
    function authorizeStage() {
        return { phase: PHASE.AUTHORIZE, present: false, degraded: "AUTHORIZE_UNAVAILABLE" };
    }

    function actStage() {
        const report = { phase: PHASE.ACT, present: true };
        if (!effectors) { report.present = false; return report; }
        return report;
    }

    function observeEffectStage() {
        const report = { phase: PHASE.OBSERVE_EFFECT, present: true };
        if (!sensoriumBridge) { report.present = false; return report; }
        return report;
    }

    function verifyStage() {
        return { phase: PHASE.VERIFY, present: false, degraded: "VERIFY_UNAVAILABLE" };
    }

    function updateStage() {
        const report = { phase: PHASE.UPDATE, present: true };
        if (!cycle) { report.present = false; return report; }
        const lanes = safeData(cycle, "lanes");
        if (!lanes || !safeData(lanes, "worldModel") || !safeData(lanes, "selfModel")) {
            report.present = false;
        }
        return report;
    }

    const STAGES = {
        [PHASE.OBSERVE]: observeStage,
        [PHASE.INTERPRET]: interpretStage,
        [PHASE.PREDICT]: predictStage,
        [PHASE.PLAN]: planStage,
        [PHASE.AUTHORIZE]: authorizeStage,
        [PHASE.ACT]: actStage,
        [PHASE.OBSERVE_EFFECT]: observeEffectStage,
        [PHASE.VERIFY]: verifyStage,
        [PHASE.UPDATE]: updateStage
    };

    function runCycle() {
        const now = safeNowMs(clock);
        let minInterval;
        try { minInterval = safeBounds.MIN_LOOP_INTERVAL_MS; } catch { minInterval = BOUNDS.MIN_LOOP_INTERVAL_MS; }
        if (lastAdvanceMs !== null && (now - lastAdvanceMs) < minInterval) {
            fail(REASONS.LOOP_RATE_EXCEEDED, "loop rate bound exceeded");
        }
        lastAdvanceMs = now;

        const idx = currentPhase === null ? -1 : LOOP_ORDER.indexOf(currentPhase);
        const nextIndex = (idx + 1) % LOOP_ORDER.length;
        const phase = LOOP_ORDER[nextIndex];
        if (nextIndex === 0) cycleCount += 1;

        const report = STAGES[phase]();
        currentPhase = phase;

        if (report.degraded) {
            degraded.push(Object.freeze({ phase, reason: report.degraded, atMs: now }));
            if (degraded.length > 64) degraded = degraded.slice(-64);
            audit("cognition.closedloop.degraded", { phase, reason: report.degraded });
        }

        audit("cognition.closedloop.phase", { phase, present: report.present === true });

        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            phase,
            cycleCount,
            present: report.present === true,
            degraded: report.degraded ?? null
        });
    }

    function getPhase() { return currentPhase; }

    function getLoopStatus() {
        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            phase: currentPhase,
            cycleCount,
            lastAdvanceMs,
            lanesPresent,
            degraded: Object.freeze([...degraded])
        });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        laws,
        bounds: safeBounds,
        runCycle,
        getPhase,
        getLoopStatus
    });
}

module.exports = { createClosedLoop, createCompletionVerifier, PHASE, LOOP_ORDER, laws, BOUNDS, SCHEMA_VERSION };
