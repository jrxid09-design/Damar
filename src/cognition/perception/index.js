"use strict";

/**
 * W8-L2 active perception. This lane records cited questions and creates
 * bounded probe requests. It never performs a probe or decides Authority.
 */

const { types: utilTypes } = require("node:util");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { REASONS, fail, PerceptionError } = require("./errors");
const { validQuestionText } = require("./question");
const { validProbeIdentity } = require("./probe");
const { classifyDescriptor } = require("./classify");
const { gainForClass } = require("./gain");
const { pairKey, belowBound } = require("./schedule");

const IS_PROXY = utilTypes.isProxy;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const REFLECT_APPLY = Reflect.apply;
const FREEZE = Object.freeze;
const KV_KEY = "perception.questions.v1";
const CLASS_COST = Object.freeze({ LOCAL: 1, INTERACTIVE: 2, REMOTE: 6, WORLD_CHANGING: 8 });
const MAX_CITATION_SCAN = 8192;

function readFields(spec, fields, optional = []) {
    if (!spec || typeof spec !== "object" || IS_PROXY(spec)) fail(REASONS.INVALID_RECORD, "input must be a verifiable plain object");
    let proto;
    try { proto = Object.getPrototypeOf(spec); } catch { fail(REASONS.INVALID_RECORD, "input cannot be verified"); }
    if (proto !== Object.prototype && proto !== null) fail(REASONS.INVALID_RECORD, "input must be a plain data object");
    let keys;
    try { keys = Reflect.ownKeys(spec); } catch { fail(REASONS.INVALID_RECORD, "input cannot be verified"); }
    if (keys.some(key => typeof key !== "string" || (!fields.includes(key) && !optional.includes(key)))) fail(REASONS.INVALID_RECORD, "input contains unsupported fields");
    const out = {};
    for (const field of [...fields, ...optional]) {
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
    if (!value || typeof value !== "object" || IS_PROXY(value) || depth > 8 || ++budget.nodes > 32768) fail(REASONS.INVALID_RECORD, "unverifiable data rejected");
    let proto;
    try { proto = Object.getPrototypeOf(value); } catch { fail(REASONS.INVALID_RECORD, "unverifiable data rejected"); }
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) fail(REASONS.INVALID_RECORD, "non-data object rejected");
    if (Array.isArray(value)) {
        const length = GET_DESCRIPTOR(value, "length")?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 4096) fail(REASONS.INVALID_RECORD, "descriptor array exceeds bound");
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
        [attentionPort, ["ingestSignal", "pick", "peekTopTarget", "toGovernorPriority", "complete", "overloadState"]]
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
    if (!append) fail(REASONS.AUDIT_UNAVAILABLE, "a synchronous audit sink is required");
    const getKv = resolveMethod(store, "getKv");
    const putKv = resolveMethod(store, "putKv");
    const now = () => {
        const fn = resolveMethod(clock, "nowMs");
        try { const n = fn ? REFLECT_APPLY(fn, clock, []) : NaN; return Number.isFinite(n) ? n : Date.now(); }
        catch { return Date.now(); }
    };
    const audit = (eventType, metadata) => {
        try {
            // The callback is synchronous; only an explicit false is refusal.
            const acknowledgement = REFLECT_APPLY(append, auditLedger, [FREEZE({ eventType, source: "acc.perception", outcome: "ok", metadata: FREEZE({ lane: "W8-L2", ...metadata }) })]);
            if (acknowledgement === false) fail(REASONS.AUDIT_UNAVAILABLE, "synchronous audit sink rejected the event");
        } catch { fail(REASONS.AUDIT_UNAVAILABLE, "synchronous audit acknowledgement failed"); }
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
    // A lifetime cap is deliberately stricter than wall-clock cycle buckets,
    // which admit twice the intended requests at a minute rollover.
    let probeAdmissions = 0;
    const interactiveTimes = [];
    const attentionTargets = new Map();
    const attentionPicked = new Set();

    function reapExpired() {
        const current = now();
        for (const [key, probe] of probes) {
            if (probe.state === "SCHEDULED" && current >= Date.parse(probe.request.deadline)) {
                audit("cognition.perception.probe_expired", { probeId: probe.request.probeId, questionRef: probe.request.questionRef });
                probes.set(key, FREEZE({ ...probe, state: "EXPIRED" }));
            }
        }
    }

    function findArrayRecord(array, keys, ref) {
        if (!Array.isArray(array) || IS_PROXY(array)) return null;
        let length;
        try { length = GET_DESCRIPTOR(array, "length")?.value; } catch { return null; }
        if (!Number.isSafeInteger(length) || length < 0) return null;
        // Upstream cognition collections can exceed L2's own question bound.
        // Inspect only the fields needed for citation and impose a scan ceiling;
        // never clone/reject the whole upstream collection due to its size.
        for (let i = 0, end = Math.min(length, MAX_CITATION_SCAN); i < end; i++) {
            let item;
            try {
                const slot = GET_DESCRIPTOR(array, String(i));
                if (!slot || slot.get || slot.set || !slot.value || typeof slot.value !== "object" || IS_PROXY(slot.value)) continue;
                item = slot.value;
            } catch { continue; }
            let proto;
            try { proto = Object.getPrototypeOf(item); } catch { continue; }
            if (proto !== Object.prototype && proto !== null) continue;
            let values;
            try {
                values = keys.map(key => {
                    const d = GET_DESCRIPTOR(item, key);
                    return d && !d.get && !d.set ? d.value : undefined;
                });
            } catch { continue; }
            if (values.some(value => value === ref)) return item;
        }
        return null;
    }

    function citation(ref) {
        let unknowns;
        try { unknowns = safeCall(selfModel, "unknowns"); } catch { unknowns = null; }
        const unknown = findArrayRecord(unknowns, ["subject"], ref);
        if (unknown) {
            let cost;
            try { const d = GET_DESCRIPTOR(unknown, "probeCost"); cost = d && !d.get && !d.set ? d.value : undefined; } catch {}
            return { sourceKind: "UNKNOWN", probeCost: cost };
        }
        let contradictions;
        try { contradictions = safeCall(worldModel, "openContradictions"); } catch { contradictions = null; }
        if (findArrayRecord(contradictions, ["contradictionSetId"], ref)) return { sourceKind: "CONTRADICTION", probeCost: "EXPENSIVE" };
        let hypotheses;
        try { hypotheses = safeCall(worldModel, "hypotheses"); } catch { hypotheses = null; }
        if (findArrayRecord(hypotheses, ["hypothesisId"], ref)) return { sourceKind: "HYPOTHESIS", probeCost: "EXPENSIVE" };
        return null;
    }

    async function persist() {
        reapExpired();
        if (!putKv) return false;
        const saved = [...questions.values()].map(q => ({ ...q }));
        await REFLECT_APPLY(putKv, store, [KV_KEY, { schemaVersion: SCHEMA_VERSION, questions: saved }]);
        return true;
    }

    function openQuestion(spec) {
        reapExpired();
        const { questionRef, question } = readFields(spec, ["questionRef", "question"]);
        const citationRecord = typeof questionRef === "string" && questionRef.length <= 200 ? citation(questionRef) : null;
        if (typeof questionRef !== "string" || !questionRef || !citationRecord) {
            audit("cognition.perception.question_refused", { reason: "uncited-question" });
            fail(REASONS.UNKNOWN_QUESTION, "questionRef must cite a current W7 unknown, open contradiction, or hypothesis");
        }
        if (!validQuestionText(question, bounds.MAX_QUESTION_CHARS)) fail(REASONS.INVALID_RECORD, "question text is required and bounded");
        const sourceKind = citationRecord.sourceKind;
        const probeCost = ["NONE", "CHEAP", "EXPENSIVE", "OWNER"].includes(citationRecord.probeCost) ? citationRecord.probeCost : "OWNER";
        const prior = questions.get(questionRef);
        if (prior) return prior;
        if (questions.size >= bounds.MAX_QUESTIONS) fail(REASONS.BOUND_EXCEEDED, "question capacity reached");
        audit("cognition.perception.question_opened", { questionRef, sourceKind });
        let attentionTargetId;
        try {
            const ingestSignal = resolveMethod(attentionPort, "ingestSignal");
            const signalResult = REFLECT_APPLY(ingestSignal, attentionPort, [FREEZE({
                signalId: `w8-l2:${questionRef}`, sourceKind: "SENSOR", sourceId: "w8-l2",
                subjectRef: FREEZE({ questionRef }), proposedUrgency: 0.5,
                evidenceRef: FREEZE({ questionRef }), createdAtMs: now()
            }), "PERCEIVE"]);
            attentionTargetId = signalResult?.targetId;
            const peek = REFLECT_APPLY(resolveMethod(attentionPort, "peekTopTarget"), attentionPort, []);
            if (peek?.priorityClass) REFLECT_APPLY(resolveMethod(attentionPort, "toGovernorPriority"), attentionPort, [peek.priorityClass]);
            if (typeof attentionTargetId !== "string" || !attentionTargetId) throw new Error("attention did not admit target");
        } catch {
            audit("cognition.perception.question_refused", { reason: "attention-unavailable" });
            fail(REASONS.BUDGET_EXHAUSTED, "attention lane refused the question");
        }
        const record = FREEZE({ questionRef, question: question.trim(), sourceKind, probeCost, state: "OPEN", createdAtMs: now(), accruedCost: 0, attempts: 0, lastRefusal: null });
        questions.set(questionRef, record);
        attentionTargets.set(questionRef, attentionTargetId);
        return record;
    }

    function proposeProbe(spec) {
        reapExpired();
        const { questionRef, probeId, capabilityId, deadline } = readFields(spec, ["questionRef", "probeId", "capabilityId", "deadline"]);
        const q = questions.get(questionRef);
        if (!q) fail(REASONS.UNKNOWN_QUESTION, "question is not open in this lane");
        if (q.state !== "OPEN") fail(REASONS.QUESTION_BLOCKED, "question is not probeable");
        if (!citation(questionRef)) {
            audit("cognition.perception.probe_refused", { probeId: typeof probeId === "string" ? probeId : null, reason: "citation-unavailable" });
            questions.set(questionRef, FREEZE({ ...q, lastRefusal: "CITATION_UNAVAILABLE" }));
            fail(REASONS.QUESTION_BLOCKED, "upstream citation is no longer available");
        }
        if (!validProbeIdentity(probeId, capabilityId)) fail(REASONS.INVALID_RECORD, "probeId and capabilityId are required strings");
        if (typeof deadline !== "number" && typeof deadline !== "string") fail(REASONS.INVALID_RECORD, "deadline must be an absolute timestamp");
        const deadlineMs = typeof deadline === "number" ? deadline : Date.parse(deadline);
        if (!Number.isFinite(deadlineMs) || deadlineMs <= now()) fail(REASONS.INVALID_RECORD, "deadline must be an absolute future timestamp");
        const pair = pairKey(questionRef, probeId);
        if (probes.has(pair)) return probes.get(pair);
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
        const { cls, gain, cost, privacyClass } = classifyDescriptor(descriptor, safeClone, CLASS_COST, gainForClass);
        audit("cognition.perception.probe_classified", { probeId, class: cls, gain, privacyClass, capabilityId });
        let availabilityState;
        try {
            const availabilityDescriptor = availability && typeof availability === "object" && !IS_PROXY(availability)
                ? GET_DESCRIPTOR(availability, "availability") : null;
            if (availabilityDescriptor && !availabilityDescriptor.get && !availabilityDescriptor.set) availabilityState = availabilityDescriptor.value;
        } catch { availabilityState = undefined; }
        if (availabilityState !== "AVAILABLE") {
            audit("cognition.perception.authorization_refused", { probeId, reason: "capability-unavailable" });
            const updated = FREEZE({ ...q, state: "OPEN", lastRefusal: "CAPABILITY_UNAVAILABLE" });
            questions.set(questionRef, updated);
            return FREEZE({ state: "PARKED", reason: "OWNER", questionRef, probeId });
        }
        if (q.probeCost === "OWNER") {
            audit("cognition.perception.probe_refused", { probeId, reason: "owner-cost" });
            return FREEZE({ state: "PARKED", reason: "OWNER", questionRef, probeId });
        }
        const hourAgo = now() - 60 * 60_000;
        while (interactiveTimes.length && interactiveTimes[0] <= hourAgo) interactiveTimes.shift();
        const activeCount = [...probes.values()].filter(p => p.state === "SCHEDULED").length;
        const isInteractive = cls === "INTERACTIVE";
        if (safeCall(attentionPort, "overloadState") === "HARD" || probeAdmissions >= bounds.MAX_PROBES_PER_CYCLE ||
            (isInteractive && interactiveTimes.length >= bounds.MAX_INTERACTIVE_PROBES_PER_HOUR) ||
            !belowBound(probeAdmissions, bounds.MAX_PROBES_PER_CYCLE) || q.attempts >= bounds.MAX_ATTEMPTS_PER_QUESTION || activeCount >= bounds.MAX_CONCURRENT_PROBES) {
            audit("cognition.perception.probe_refused", { probeId, reason: "budget-exhausted" });
            const updated = FREEZE({ ...q, state: "OPEN", lastRefusal: "BUDGET_EXHAUSTED" });
            questions.set(questionRef, updated);
            return FREEZE({ state: "DEFERRED", reason: "BUDGET_EXHAUSTED", questionRef, probeId });
        }
        const request = FREEZE({
            envelope: FREEZE({ schemaVersion: SCHEMA_VERSION, questionRef, citation: q.questionRef }),
            probeId, questionRef, class: cls, privacyClass, capabilityId, gain, cost,
            deadline: new Date(deadlineMs).toISOString(), state: "REQUESTED",
            authorityRequired: cls !== "LOCAL", dispatch: null
        });
        audit("cognition.perception.authorization_allowed", { probeId, questionRef, class: cls, privacyClass });
        audit("cognition.perception.probe_schedule_requested", { probeId, questionRef, class: cls, cost, authorityRequired: request.authorityRequired });
        if (!attentionPicked.has(questionRef)) {
            try {
                const top = REFLECT_APPLY(resolveMethod(attentionPort, "peekTopTarget"), attentionPort, []);
                if (!top || top.targetId !== attentionTargets.get(questionRef)) {
                    audit("cognition.perception.authorization_refused", { probeId, reason: "attention-deferred" });
                    return FREEZE({ state: "DEFERRED", reason: "BUDGET_EXHAUSTED", questionRef, probeId });
                }
                const picked = REFLECT_APPLY(resolveMethod(attentionPort, "pick"), attentionPort, []);
                if (!picked || picked.targetId !== attentionTargets.get(questionRef)) {
                    audit("cognition.perception.authorization_refused", { probeId, reason: "attention-deferred" });
                    return FREEZE({ state: "DEFERRED", reason: "BUDGET_EXHAUSTED", questionRef, probeId });
                }
                REFLECT_APPLY(resolveMethod(attentionPort, "toGovernorPriority"), attentionPort, [picked.priorityClass]);
                attentionPicked.add(questionRef);
            } catch {
                audit("cognition.perception.authorization_refused", { probeId, reason: "attention-unavailable" });
                return FREEZE({ state: "DEFERRED", reason: "BUDGET_EXHAUSTED", questionRef, probeId });
            }
        }
        const nextQ = FREEZE({ ...q, attempts: q.attempts + 1, accruedCost: q.accruedCost + cost });
        questions.set(questionRef, nextQ);
        const scheduled = FREEZE({ request, state: "SCHEDULED", createdAtMs: now() });
        probes.set(pair, scheduled);
        probeAdmissions++;
        if (isInteractive) interactiveTimes.push(now());
        return scheduled;
    }

    function scheduleProbe(spec) { return proposeProbe(spec); }

    function probeResult(spec) {
        const { probeId, questionRef, observation, outcome = "SUCCESS" } = readFields(spec, ["probeId", "observation", "outcome"], ["questionRef"]);
        if (questionRef !== undefined && (typeof questionRef !== "string" || !questionRef)) fail(REASONS.INVALID_RECORD, "questionRef must be a non-empty string when supplied");
        const match = findProbe(probeId, questionRef);
        const scheduled = match?.record;
        if (!scheduled || scheduled.state !== "SCHEDULED") fail(REASONS.PROBE_UNAVAILABLE, "probe is not in flight");
        if (now() >= Date.parse(scheduled.request.deadline)) {
            audit("cognition.perception.probe_expired", { probeId });
            probes.set(match.key, FREEZE({ ...scheduled, state: "EXPIRED" }));
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
            audit("cognition.perception.authorization_refused", { probeId, reason: "probe-denied" });
            questions.set(q.questionRef, FREEZE({ ...q, state: "OPEN", lastRefusal: "PROBE_DENIED" }));
            probes.set(match.key, FREEZE({ ...scheduled, state: "BLOCKED" }));
            return FREEZE({ state: "BLOCKED", probeId, observation: null });
        }
        const safeObservation = safeClone(observation);
        if (!safeObservation || typeof safeObservation !== "object" || safeObservation.tier !== "T4" || !safeObservation.sensor || !Object.hasOwn(safeObservation, "frame") || !Object.hasOwn(safeObservation, "quality")) fail(REASONS.INVALID_RECORD, "probe result must be an L1 T4 Observation");
        audit("cognition.perception.probe_completed", { probeId });
        probes.set(match.key, FREEZE({ ...scheduled, state: "COMPLETED" }));
        // The caller must pass this canonical Observation through the bound L1 bridge.
        return FREEZE({ state: "COMPLETED", probeId, observation: safeObservation, sensoriumBridgeRequired: true });
    }

    function closeQuestion(questionRef) {
        reapExpired();
        const q = questions.get(questionRef);
        if (!q) fail(REASONS.UNKNOWN_QUESTION, "question is unknown");
        const closed = FREEZE({ ...q, state: "CLOSED", closedAtMs: now() });
        audit("cognition.perception.question_closed", { questionRef });
        if (attentionPicked.has(questionRef)) {
            const attentionTargetId = attentionTargets.get(questionRef);
            REFLECT_APPLY(resolveMethod(attentionPort, "complete"), attentionPort, [attentionTargetId]);
            attentionPicked.delete(questionRef);
        }
        questions.set(questionRef, closed);
        for (const [key, probe] of probes) {
            if (probe.request.questionRef === questionRef && probe.state === "SCHEDULED") {
                probes.set(key, FREEZE({ ...probe, state: "CANCELLED" }));
            }
        }
        return closed;
    }

    function findProbe(probeId, questionRef) {
        if (typeof probeId !== "string") return null;
        if (typeof questionRef === "string") {
            const key = pairKey(questionRef, probeId);
            const record = probes.get(key);
            return record ? { key, record } : null;
        }
        let found = null;
        for (const [key, record] of probes) {
            if (record.request.probeId !== probeId) continue;
            if (found) return null; // ambiguous legacy lookup fails closed
            found = { key, record };
        }
        return found;
    }

    function getQuestion(questionRef) { reapExpired(); return questions.get(questionRef) ?? null; }
    function openQuestions() { reapExpired(); return FREEZE([...questions.values()].filter(q => q.state !== "CLOSED")); }
    function getProbe(probeId, questionRef) { reapExpired(); return findProbe(probeId, questionRef)?.record ?? null; }
    function probeCounts() { reapExpired(); return FREEZE({ questions: questions.size, inFlight: [...probes.values()].filter(p => p.state === "SCHEDULED").length }); }

    function auditedOperation(operation, eventType) {
        return (...args) => {
            try { return operation(...args); }
            catch (error) {
                let auditFailure = false;
                try {
                    const reason = error && typeof error === "object" && !IS_PROXY(error) ? GET_DESCRIPTOR(error, "reason") : null;
                    auditFailure = error instanceof PerceptionError && reason && !reason.get && reason.value === REASONS.AUDIT_UNAVAILABLE;
                } catch { auditFailure = false; }
                if (!auditFailure) {
                    try { audit(eventType, { reason: "operation-rejected" }); } catch { /* original failure remains closed */ }
                }
                throw error;
            }
        };
    }

    if (!coldStart) audit("cognition.perception.recovered", { questions: questions.size, abandonedInflight: 0 });
    return FREEZE({ schemaVersion: SCHEMA_VERSION, perceptionColdStart: coldStart,
        openQuestion: auditedOperation(openQuestion, "cognition.perception.question_refused"),
        proposeProbe: auditedOperation(proposeProbe, "cognition.perception.probe_refused"),
        scheduleProbe: auditedOperation(proposeProbe, "cognition.perception.probe_refused"),
        probeResult: auditedOperation(probeResult, "cognition.perception.probe_result_refused"),
        closeQuestion: auditedOperation(closeQuestion, "cognition.perception.question_refused"),
        getQuestion, openQuestions, getProbe, probeCounts, persist, laws, bounds });
}

module.exports = { createPerception, BOUNDS, SCHEMA_VERSION, KV_KEY };
