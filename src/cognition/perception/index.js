"use strict";

/**
 * W8-L2 active perception. This lane records cited questions and creates
 * bounded probe requests. It never performs a probe or decides Authority.
 */

const crypto = require("node:crypto");
const { types: utilTypes } = require("node:util");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { REASONS, fail } = require("./errors");

const IS_PROXY = utilTypes.isProxy;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REFLECT_APPLY = Reflect.apply;
const FREEZE = Object.freeze;
const KV_KEY = "perception.questions.v1";
const CLASS_COST = Object.freeze({ LOCAL: 1, INTERACTIVE: 2, REMOTE: 6, WORLD_CHANGING: 8 });

function readFields(spec, fields) {
    if (!spec || typeof spec !== "object" || IS_PROXY(spec)) fail(REASONS.INVALID_RECORD, "input must be a verifiable plain object");
    let proto;
    try { proto = Object.getPrototypeOf(spec); } catch { fail(REASONS.INVALID_RECORD, "input cannot be verified"); }
    if (proto !== Object.prototype && proto !== null) fail(REASONS.INVALID_RECORD, "input must be a plain data object");
    const out = {};
    for (const field of fields) {
        let desc;
        try { desc = GET_DESCRIPTOR(spec, field); } catch { fail(REASONS.INVALID_RECORD, "input cannot be verified"); }
        if (desc && (desc.get || desc.set)) fail(REASONS.INVALID_RECORD, `accessor '${field}' is not accepted`);
        out[field] = desc?.value;
    }
    return out;
}

function safeCall(receiver, name, args = []) {
    let fn;
    try {
        let at = receiver;
        while (at && at !== Object.prototype) {
            if (IS_PROXY(at)) return undefined;
            const d = GET_DESCRIPTOR(at, name);
            if (d) { if (d.get || d.set) return undefined; fn = d.value; break; }
            at = Object.getPrototypeOf(at);
        }
        if (typeof fn !== "function") return undefined;
        return REFLECT_APPLY(fn, receiver, args);
    } catch { return undefined; }
}

function safeClone(value, depth = 0, budget = { nodes: 0 }) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        if (typeof value === "string" && value.length > 2048) fail(REASONS.INVALID_RECORD, "descriptor string exceeds bound");
        if (typeof value === "number" && !Number.isFinite(value)) fail(REASONS.INVALID_RECORD, "non-finite data rejected");
        return value;
    }
    if (!value || typeof value !== "object" || IS_PROXY(value) || depth > 8 || ++budget.nodes > 512) fail(REASONS.INVALID_RECORD, "unverifiable data rejected");
    let proto;
    try { proto = Object.getPrototypeOf(value); } catch { fail(REASONS.INVALID_RECORD, "unverifiable data rejected"); }
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) fail(REASONS.INVALID_RECORD, "non-data object rejected");
    if (Array.isArray(value)) {
        const length = GET_DESCRIPTOR(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 128) fail(REASONS.INVALID_RECORD, "descriptor array exceeds bound");
        const out = [];
        for (let i = 0; i < length; i++) {
            const d = GET_DESCRIPTOR(value, String(i));
            if (!d || d.get || d.set) fail(REASONS.INVALID_RECORD, "array accessors rejected");
            out.push(safeClone(d.value, depth + 1, budget));
        }
        return FREEZE(out);
    }
    const out = {};
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) fail(REASONS.INVALID_RECORD, "descriptor has too many fields");
    for (const key of keys) {
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) fail(REASONS.INVALID_RECORD, "unsafe key rejected");
        if (key.length > 128) fail(REASONS.INVALID_RECORD, "descriptor key exceeds bound");
        const d = GET_DESCRIPTOR(value, key);
        if (!d || d.get || d.set) fail(REASONS.INVALID_RECORD, "accessors rejected");
        out[key] = safeClone(d.value, depth + 1, budget);
    }
    return FREEZE(out);
}

function resolveMethod(port, name) {
    if (!port || typeof port !== "object" || IS_PROXY(port)) return null;
    let at = port;
    while (at && at !== Object.prototype) {
        if (IS_PROXY(at)) return null;
        let d;
        try { d = GET_DESCRIPTOR(at, name); } catch { return null; }
        if (d) return !d.get && !d.set && typeof d.value === "function" ? d.value : null;
        try { at = Object.getPrototypeOf(at); } catch { return null; }
    }
    return null;
}

async function createPerception({ capabilityRegistry, selfModel, worldModel, attentionPort, trustedResultAdapter = null, store = null, auditLedger = null, clock = { nowMs: () => Date.now() }, bounds = BOUNDS } = {}) {
    for (const [port, names] of [
        [capabilityRegistry, ["get", "has", "getAvailability"]],
        [selfModel, ["unknowns"]], [worldModel, ["openContradictions", "hypotheses"]],
        [attentionPort, ["overloadState", "peekTopTarget"]]
    ]) {
        if (!port || names.some(n => !resolveMethod(port, n))) fail(REASONS.INVALID_RECORD, `required upstream port missing: ${names.join("/")}`);
    }
    const cleanBounds = {};
    let safeBounds = bounds;
    try {
        if (!safeBounds || typeof safeBounds !== "object" || IS_PROXY(safeBounds)) safeBounds = BOUNDS;
    } catch { safeBounds = BOUNDS; }
    for (const key of Object.keys(BOUNDS)) {
        let d;
        try { d = GET_DESCRIPTOR(safeBounds, key); } catch { d = null; }
        const value = d && !d.get && !d.set ? d.value : BOUNDS[key];
        cleanBounds[key] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : BOUNDS[key];
    }
    bounds = FREEZE(cleanBounds);

    const append = resolveMethod(auditLedger, "append");
    const getKv = resolveMethod(store, "getKv");
    const putKv = resolveMethod(store, "putKv");
    const now = () => {
        const fn = resolveMethod(clock, "nowMs");
        try { const n = fn ? REFLECT_APPLY(fn, clock, []) : NaN; return Number.isFinite(n) ? n : Date.now(); }
        catch { return Date.now(); }
    };
    const audit = (eventType, metadata) => {
        if (!append) return;
        try {
            // The callback is synchronous. Its return is intentionally ignored.
            REFLECT_APPLY(append, auditLedger, [FREEZE({ eventType, source: "acc.perception", outcome: "ok", metadata: FREEZE({ lane: "W8-L2", ...metadata }) })]);
        } catch { /* audit failure never creates authority */ }
    };

    const questions = new Map();
    let coldStart = true;
    if (getKv) {
        try {
            const rawSnapshot = await REFLECT_APPLY(getKv, store, [KV_KEY]);
            const snapshot = rawSnapshot && typeof rawSnapshot === "object" ? safeClone(rawSnapshot) : null;
            if (snapshot && snapshot.schemaVersion === SCHEMA_VERSION && Array.isArray(snapshot.questions) && snapshot.questions.length <= bounds.MAX_QUESTIONS) {
                const restored = [];
                for (const q of snapshot.questions) {
                    if (!q || typeof q.questionRef !== "string" || !q.questionRef || q.questionRef.length > 200 ||
                        typeof q.question !== "string" || q.question.length > bounds.MAX_QUESTION_CHARS ||
                        !["UNKNOWN", "CONTRADICTION", "HYPOTHESIS"].includes(q.sourceKind) ||
                        !["NONE", "CHEAP", "EXPENSIVE", "OWNER"].includes(q.probeCost) ||
                        !["OPEN", "CLOSED"].includes(q.state) || !Number.isFinite(q.createdAtMs) ||
                        !Number.isSafeInteger(q.attempts) || q.attempts < 0 || q.attempts > bounds.MAX_ATTEMPTS_PER_QUESTION ||
                        !Number.isFinite(q.accruedCost) || q.accruedCost < 0) {
                        throw new Error("persisted question invalid");
                    }
                    restored.push(q);
                }
                for (const q of restored) questions.set(q.questionRef, FREEZE({ ...q }));
                coldStart = false;
            } else if (rawSnapshot !== null && rawSnapshot !== undefined) {
                audit("cognition.perception.store_unreadable", { reason: "snapshot-invalid" });
            }
        } catch { audit("cognition.perception.store_unreadable", { reason: "store-unreadable-or-hostile" }); }
    }
    // Ephemeral in-flight probe state is never recovered after restart.
    const probes = new Map();
    const seenPairs = new Map();
    const cycleCounts = new Map();
    const interactiveTimes = [];

    function citation(ref) {
        let unknowns;
        try { unknowns = safeClone(safeCall(selfModel, "unknowns")); } catch { unknowns = null; }
        if (Array.isArray(unknowns)) {
            const found = unknowns.find(x => x && x.subject === ref);
            if (found) return { sourceKind: "UNKNOWN", probeCost: found.probeCost };
        }
        let contradictions;
        try { contradictions = safeClone(safeCall(worldModel, "openContradictions")); } catch { contradictions = null; }
        if (Array.isArray(contradictions)) {
            const found = contradictions.find(x => x && (x.contradictionSetId === ref || x.challengerRecordId === ref));
            if (found) return { sourceKind: "CONTRADICTION", probeCost: "EXPENSIVE" };
        }
        let hypotheses;
        try { hypotheses = safeClone(safeCall(worldModel, "hypotheses")); } catch { hypotheses = null; }
        if (Array.isArray(hypotheses) && hypotheses.some(x => x && x.hypothesisId === ref)) return { sourceKind: "HYPOTHESIS", probeCost: "EXPENSIVE" };
        return null;
    }

    async function persist() {
        if (!putKv) return false;
        const saved = [...questions.values()].map(q => ({ ...q }));
        await REFLECT_APPLY(putKv, store, [KV_KEY, { schemaVersion: SCHEMA_VERSION, questions: saved }]);
        return true;
    }

    function openQuestion(spec) {
        const { questionRef, question } = readFields(spec, ["questionRef", "question"]);
        const citationRecord = typeof questionRef === "string" && questionRef.length <= 200 ? citation(questionRef) : null;
        if (typeof questionRef !== "string" || !questionRef || !citationRecord) {
            audit("cognition.perception.question_refused", { reason: "uncited-question" });
            fail(REASONS.UNKNOWN_QUESTION, "questionRef must cite a current W7 unknown, open contradiction, or hypothesis");
        }
        if (typeof question !== "string" || !question.trim() || question.length > bounds.MAX_QUESTION_CHARS) fail(REASONS.INVALID_RECORD, "question text is required and bounded");
        const sourceKind = citationRecord.sourceKind;
        const probeCost = ["NONE", "CHEAP", "EXPENSIVE", "OWNER"].includes(citationRecord.probeCost) ? citationRecord.probeCost : "OWNER";
        const prior = questions.get(questionRef);
        if (prior) return prior;
        if (questions.size >= bounds.MAX_QUESTIONS) fail(REASONS.BOUND_EXCEEDED, "question capacity reached");
        const record = FREEZE({ questionRef, question: question.trim(), sourceKind, probeCost, state: "OPEN", createdAtMs: now(), accruedCost: 0, attempts: 0, lastRefusal: null });
        questions.set(questionRef, record);
        audit("cognition.perception.question_opened", { questionRef, sourceKind });
        return record;
    }

    function classify(descriptor) {
        const d = safeClone(descriptor);
        // World-changing/remote use requires the full downstream Authority path.
        const kind = typeof d.kind === "string" ? d.kind.toLowerCase() : "";
        const source = typeof d.source === "string" ? d.source.toLowerCase() : "";
        const descriptorClass = `${kind} ${source}`;
        const cls = /world|actuat|write|control/.test(descriptorClass) ? "WORLD_CHANGING" :
            /remote|network/.test(descriptorClass) ? "REMOTE" :
            /interactive|camera|microphone|sensor/.test(descriptorClass) ? "INTERACTIVE" :
            /local|read|query/.test(descriptorClass) ? "LOCAL" : "WORLD_CHANGING";
        const gain = cls === "LOCAL" ? 0.7 : cls === "INTERACTIVE" ? 0.5 : cls === "REMOTE" ? 0.3 : 0.25;
        const sensitivity = [d.sensitivity, d.dataSensitivity, d.privacyClass].find(v => typeof v === "string" && ["PRIVATE", "SENSITIVE", "PERSONAL"].includes(v.toUpperCase()));
        const privateData = d.containsPrivateData === true || sensitivity !== undefined;
        return { cls, gain, cost: CLASS_COST[cls], privacyClass: privateData ? "PRIVATE" : "PUBLIC" };
    }

    function proposeProbe(spec) {
        const { questionRef, probeId, capabilityId, deadline } = readFields(spec, ["questionRef", "probeId", "capabilityId", "deadline"]);
        const q = questions.get(questionRef);
        if (!q) fail(REASONS.UNKNOWN_QUESTION, "question is not open in this lane");
        if (q.state !== "OPEN") fail(REASONS.QUESTION_BLOCKED, "question is not probeable");
        if (!citation(questionRef)) {
            questions.set(questionRef, FREEZE({ ...q, lastRefusal: "CITATION_UNAVAILABLE" }));
            audit("cognition.perception.probe_refused", { probeId: typeof probeId === "string" ? probeId : null, reason: "citation-unavailable" });
            fail(REASONS.QUESTION_BLOCKED, "upstream citation is no longer available");
        }
        if ([probeId, capabilityId].some(x => typeof x !== "string" || !x || x.length > 200)) fail(REASONS.INVALID_RECORD, "probeId and capabilityId are required strings");
        if (typeof deadline !== "number" && typeof deadline !== "string") fail(REASONS.INVALID_RECORD, "deadline must be an absolute timestamp");
        const deadlineMs = typeof deadline === "number" ? deadline : Date.parse(deadline);
        if (!Number.isFinite(deadlineMs) || deadlineMs <= now()) fail(REASONS.INVALID_RECORD, "deadline must be an absolute future timestamp");
        const pair = `${questionRef}\u0000${probeId}`;
        if (seenPairs.has(pair)) return seenPairs.get(pair);
        let exists = false, descriptor = null, availability = null;
        try {
            exists = REFLECT_APPLY(resolveMethod(capabilityRegistry, "has"), capabilityRegistry, [capabilityId]) === true;
            descriptor = exists ? REFLECT_APPLY(resolveMethod(capabilityRegistry, "get"), capabilityRegistry, [capabilityId]) : null;
            availability = exists ? REFLECT_APPLY(resolveMethod(capabilityRegistry, "getAvailability"), capabilityRegistry, [capabilityId]) : null;
        } catch { exists = false; }
        if (!exists || !descriptor) {
            audit("cognition.perception.probe_refused", { probeId, reason: "unknown-capability" });
            fail(REASONS.UNKNOWN_CAPABILITY, "capability descriptor unavailable");
        }
        const { cls, gain, cost, privacyClass } = classify(descriptor);
        audit("cognition.perception.probe_classified", { probeId, class: cls, gain, privacyClass, capabilityId });
        let availabilityState;
        try {
            const availabilityDescriptor = availability && typeof availability === "object" && !IS_PROXY(availability)
                ? GET_DESCRIPTOR(availability, "availability") : null;
            if (availabilityDescriptor && !availabilityDescriptor.get && !availabilityDescriptor.set) availabilityState = availabilityDescriptor.value;
        } catch { availabilityState = undefined; }
        if (availabilityState !== "AVAILABLE") {
            const updated = FREEZE({ ...q, state: "OPEN", lastRefusal: "CAPABILITY_UNAVAILABLE" });
            questions.set(questionRef, updated);
            audit("cognition.perception.authorization_refused", { probeId, reason: "capability-unavailable" });
            return FREEZE({ state: "PARKED", reason: "OWNER", questionRef, probeId });
        }
        if (q.probeCost === "OWNER") {
            audit("cognition.perception.probe_refused", { probeId, reason: "owner-cost" });
            return FREEZE({ state: "PARKED", reason: "OWNER", questionRef, probeId });
        }
        const hourAgo = now() - 60 * 60_000;
        while (interactiveTimes.length && interactiveTimes[0] <= hourAgo) interactiveTimes.shift();
        const cycleKey = Math.floor(now() / 60_000);
        for (const key of cycleCounts.keys()) if (key < cycleKey) cycleCounts.delete(key);
        const cycleCount = cycleCounts.get(cycleKey) ?? 0;
        const activeCount = [...probes.values()].filter(p => p.state === "SCHEDULED").length;
        const isInteractive = cls === "INTERACTIVE";
        if (safeCall(attentionPort, "overloadState") === "HARD" || cycleCount >= bounds.MAX_PROBES_PER_CYCLE ||
            (isInteractive && interactiveTimes.length >= bounds.MAX_INTERACTIVE_PROBES_PER_HOUR) ||
            q.attempts >= bounds.MAX_ATTEMPTS_PER_QUESTION || activeCount >= bounds.MAX_CONCURRENT_PROBES) {
            const updated = FREEZE({ ...q, state: "OPEN", lastRefusal: "BUDGET_EXHAUSTED" });
            questions.set(questionRef, updated);
            audit("cognition.perception.probe_refused", { probeId, reason: "budget-exhausted" });
            return FREEZE({ state: "DEFERRED", reason: "BUDGET_EXHAUSTED", questionRef, probeId });
        }
        const request = FREEZE({
            envelope: FREEZE({ schemaVersion: SCHEMA_VERSION, questionRef, citation: q.questionRef }),
            probeId, questionRef, class: cls, privacyClass, capabilityId, gain, cost,
            deadline: new Date(deadlineMs).toISOString(), state: "REQUESTED",
            authorityRequired: cls !== "LOCAL", dispatch: null
        });
        const nextQ = FREEZE({ ...q, attempts: q.attempts + 1, accruedCost: q.accruedCost + cost });
        questions.set(questionRef, nextQ);
        const scheduled = FREEZE({ request, state: "SCHEDULED", createdAtMs: now() });
        probes.set(probeId, scheduled);
        seenPairs.set(pair, scheduled);
        cycleCounts.set(cycleKey, cycleCount + 1);
        if (isInteractive) interactiveTimes.push(now());
        audit("cognition.perception.probe_scheduled", { probeId, questionRef, class: cls, cost, authorityRequired: request.authorityRequired });
        return scheduled;
    }

    function scheduleProbe(spec) { return proposeProbe(spec); }

    function probeResult(spec) {
        const { probeId, observation, outcome = "SUCCESS" } = readFields(spec, ["probeId", "observation", "outcome"]);
        const scheduled = probes.get(probeId);
        if (!scheduled || scheduled.state !== "SCHEDULED") fail(REASONS.PROBE_UNAVAILABLE, "probe is not in flight");
        if (now() > Date.parse(scheduled.request.deadline)) {
            probes.set(probeId, FREEZE({ ...scheduled, state: "EXPIRED" }));
            audit("cognition.perception.probe_expired", { probeId });
            return FREEZE({ state: "EXPIRED", probeId });
        }
        const verifyCompletion = resolveMethod(trustedResultAdapter, "verifyCompletion");
        if (!verifyCompletion) {
            audit("cognition.perception.probe_result_refused", { probeId, reason: "completion-adapter-unbound" });
            fail(REASONS.PROBE_UNAVAILABLE, "trusted Authority/sensorium completion adapter is not bound");
        }
        let accepted = false;
        try {
            accepted = REFLECT_APPLY(verifyCompletion, trustedResultAdapter, [FREEZE({
                probeId, request: scheduled.request, outcome, observation
            })]) === true;
        } catch { accepted = false; }
        if (!accepted) {
            audit("cognition.perception.probe_result_refused", { probeId, reason: "completion-unverified" });
            fail(REASONS.PROBE_UNAVAILABLE, "probe result is not backed by canonical Authority and sensorium evidence");
        }
        if (outcome !== "SUCCESS") {
            const q = questions.get(scheduled.request.questionRef);
            questions.set(q.questionRef, FREEZE({ ...q, state: "OPEN", lastRefusal: "PROBE_DENIED" }));
            probes.set(probeId, FREEZE({ ...scheduled, state: "BLOCKED" }));
            audit("cognition.perception.authorization_refused", { probeId, reason: "probe-denied" });
            return FREEZE({ state: "BLOCKED", probeId, observation: null });
        }
        const safeObservation = safeClone(observation);
        if (!safeObservation || typeof safeObservation !== "object" || safeObservation.tier !== "T4" || !safeObservation.sensor || !safeObservation.frame) fail(REASONS.INVALID_RECORD, "probe result must be an L1 T4 Observation");
        probes.set(probeId, FREEZE({ ...scheduled, state: "COMPLETED" }));
        audit("cognition.perception.probe_completed", { probeId });
        // The caller must pass this canonical Observation through the bound L1 bridge.
        return FREEZE({ state: "COMPLETED", probeId, observation: safeObservation, sensoriumBridgeRequired: true });
    }

    function closeQuestion(questionRef) {
        const q = questions.get(questionRef);
        if (!q) fail(REASONS.UNKNOWN_QUESTION, "question is unknown");
        const closed = FREEZE({ ...q, state: "CLOSED", closedAtMs: now() });
        questions.set(questionRef, closed);
        for (const [probeId, probe] of probes) {
            if (probe.request.questionRef === questionRef && probe.state === "SCHEDULED") {
                probes.set(probeId, FREEZE({ ...probe, state: "CANCELLED" }));
            }
        }
        audit("cognition.perception.question_closed", { questionRef });
        return closed;
    }

    function getQuestion(questionRef) { return questions.get(questionRef) ?? null; }
    function openQuestions() { return FREEZE([...questions.values()].filter(q => q.state !== "CLOSED")); }
    function getProbe(probeId) { return probes.get(probeId) ?? null; }
    function probeCounts() { return FREEZE({ questions: questions.size, inFlight: [...probes.values()].filter(p => p.state === "SCHEDULED").length }); }

    if (!coldStart) audit("cognition.perception.recovered", { questions: questions.size, abandonedInflight: 0 });
    return FREEZE({ schemaVersion: SCHEMA_VERSION, perceptionColdStart: coldStart,
        openQuestion, proposeProbe, scheduleProbe, probeResult, closeQuestion,
        getQuestion, openQuestions, getProbe, probeCounts, persist, laws, bounds });
}

module.exports = { createPerception, BOUNDS, SCHEMA_VERSION, KV_KEY };
