"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");
const agentHub = require("./agentHub");

const GRAPH_TYPES = Object.freeze(["DIRECT", "PARALLEL", "SEQUENTIAL", "REVIEW_CHAIN", "COLONY"]);
const WORK_STATES = Object.freeze(["QUEUED", "READY", "WORKING", "BLOCKED", "REVIEW", "VERIFIED", "FAILED", "CANCELLED"]);
const DEPTHS = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 });
const DEFAULT_BOUNDS = Object.freeze({ maxActiveWorkers: 3, maxWidth: 5, maxDepth: 4, maxDelegations: 8, maxRetries: 1, maxWallClockMs: 120000 });
const ROLE_TERMS = Object.freeze({
    "pandawa:puntadewa": ["strategy", "synthesis", "arbitration", "planning", "decision", "architecture"],
    "pandawa:werkudara": ["security", "infrastructure", "resilience", "adversarial", "threat", "hardening"],
    "pandawa:janaka": ["engineering", "coding", "architecture", "implementation", "debugging", "code"],
    "pandawa:nakula": ["data", "statistics", "numerical", "rf", "spatial", "analytics"],
    "pandawa:sadewa": ["research", "evidence", "verification", "provenance", "source", "audit"]
});

function text(value, name, max = 4096) {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${name}_INVALID`);
    return value.trim();
}
function list(value, name, max) {
    if (!Array.isArray(value) || value.length > max) throw new TypeError(`${name}_INVALID`);
    return [...new Set(value.map(v => text(v, name, 512)))];
}
function canonical(value) {
    const result = identity.resolve(value);
    if (!result) throw new TypeError("PANDAWA_ENTITY_INVALID");
    return result.id;
}
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function freeze(value) {
    if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
    return value;
}

function selectTeam(objective, { maxMembers = 5 } = {}) {
    const input = String(objective ?? "").toLowerCase();
    const scored = identity.records().map(record => ({
        id: record.id,
        score: (ROLE_TERMS[record.id] || []).reduce((n, term) => n + (input.includes(term) ? 2 : 0), 0)
    })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const selected = scored.filter(x => x.score > 0).slice(0, Math.max(1, Math.min(maxMembers, 5)));
    return (selected.length ? selected : scored.slice(0, 1)).map(x => x.id);
}

function validateBounds(bounds = {}) {
    const out = { ...DEFAULT_BOUNDS, ...bounds };
    for (const key of Object.keys(DEFAULT_BOUNDS)) {
        if (!Number.isSafeInteger(out[key]) || out[key] < 1 || out[key] > DEFAULT_BOUNDS[key] * 8) throw new RangeError("PANDAWA_BOUNDS_INVALID");
    }
    return Object.freeze(out);
}

function makeNode({ ownerEntity, objective, dependencies = [], inputRefs = [], depth = 1, status = "QUEUED" }) {
    return {
        workId: id("pwrk"), ownerEntity: canonical(ownerEntity), objective: text(objective, "OBJECTIVE"),
        dependencies: [...dependencies], inputRefs: list(inputRefs, "INPUT_REFS", 32), resultRef: null,
        status, evidenceRefs: [], verificationState: "UNKNOWN", depth
    };
}

function assertAcyclic(nodes, maxDepth) {
    const byId = new Map(nodes.map(n => [n.workId, n]));
    for (const node of nodes) for (const dep of node.dependencies) if (!byId.has(dep)) throw new TypeError("PANDAWA_DEPENDENCY_INVALID");
    const visiting = new Set(); const done = new Set();
    function visit(node, depth) {
        if (depth > maxDepth) throw new RangeError("PANDAWA_GRAPH_DEPTH_EXCEEDED");
        if (visiting.has(node.workId)) throw new TypeError("PANDAWA_GRAPH_CYCLE");
        if (done.has(node.workId)) return;
        visiting.add(node.workId); node.dependencies.forEach(d => visit(byId.get(d), depth + 1));
        visiting.delete(node.workId); done.add(node.workId); node.depth = Math.max(node.depth, depth);
    }
    nodes.forEach(n => visit(n, 1));
}

function createWorkGraph({ type = "DIRECT", objective, members = [], steps = [], synthesisOwner = "pandawa:puntadewa", bounds = {} } = {}) {
    if (!GRAPH_TYPES.includes(type)) throw new TypeError("PANDAWA_GRAPH_TYPE_INVALID");
    const limit = validateBounds(bounds);
    const selected = (members.length ? members : selectTeam(objective, { maxMembers: type === "DIRECT" ? 1 : limit.maxWidth }))
        .map(canonical);
    if (selected.length > limit.maxWidth) throw new RangeError("PANDAWA_GRAPH_WIDTH_EXCEEDED");
    const nodes = [];
    if (steps.length) {
        if (!Array.isArray(steps) || steps.length > limit.maxWidth) throw new RangeError("PANDAWA_GRAPH_WIDTH_EXCEEDED");
        steps.forEach(step => nodes.push(makeNode({ ownerEntity: step.ownerEntity || step.agent || selected[nodes.length % selected.length], objective: step.objective || step.task, dependencies: step.dependencies || step.dependsOn || [], inputRefs: step.inputRefs || [], depth: 1 })));
    } else {
        const task = text(objective, "OBJECTIVE");
        if (type === "DIRECT") nodes.push(makeNode({ ownerEntity: selected[0], objective: task }));
        else selected.forEach((member, i) => nodes.push(makeNode({ ownerEntity: member, objective: task, dependencies: type === "SEQUENTIAL" || type === "REVIEW_CHAIN" ? (i ? [nodes[i - 1]?.workId] : []) : [], depth: type === "COLONY" ? 2 : 1 })));
    }
    if (type === "COLONY" && nodes.length < 2) throw new RangeError("PANDAWA_COLONY_NEEDS_MEMBERS");
    if (type === "COLONY" || type === "REVIEW_CHAIN") nodes.push(makeNode({ ownerEntity: synthesisOwner, objective: `Synthesize bounded results for: ${objective}`, dependencies: nodes.map(n => n.workId), depth: 2, status: "REVIEW" }));
    assertAcyclic(nodes, limit.maxDepth);
    nodes.forEach(n => { if (!n.dependencies.length) n.status = "READY"; });
    return freeze({ graphId: id("pgraph"), type, depth: type === "DIRECT" ? "L1" : type === "COLONY" ? "L4" : type === "PARALLEL" ? "L2" : "L3", objective: text(objective, "OBJECTIVE"), bounds: limit, synthesisOwner: canonical(synthesisOwner), nodes, authorityContext: null, createdAt: Date.now() });
}

async function runGraph(graph, { execute, resourceGovernor = null, onEvent = () => {} } = {}) {
    if (!graph || !Array.isArray(graph.nodes)) throw new TypeError("PANDAWA_GRAPH_INVALID");
    if (typeof execute !== "function") throw new TypeError("PANDAWA_EXECUTOR_REQUIRED");
    const nodes = graph.nodes.map(n => ({ ...n, dependencies: [...n.dependencies], evidenceRefs: [...n.evidenceRefs] }));
    const results = new Map(); let active = 0; let completed = 0; let delegations = 0;
    const started = Date.now();
    while (completed < nodes.length) {
        if (Date.now() - started > graph.bounds.maxWallClockMs) throw new Error("PANDAWA_GRAPH_WALL_CLOCK_EXCEEDED");
        const ready = nodes.filter(n => (n.status === "READY" || n.status === "REVIEW") && n.dependencies.every(d => results.has(d))).slice(0, graph.bounds.maxActiveWorkers - active);
        if (!ready.length) {
            if (nodes.some(n => ["QUEUED", "READY", "WORKING"].includes(n.status))) throw new Error("PANDAWA_GRAPH_BLOCKED");
            break;
        }
        await Promise.all(ready.map(async node => {
            active++; node.status = "WORKING"; onEvent({ type: "work:start", node: { ...node } });
            let lease = null;
            try {
                if (resourceGovernor?.admit && resourceGovernor?.release) {
                    const admission = resourceGovernor.admit(`pandawa:${node.workId}`, { workloadClass: "AGENT", concurrencyGroup: "default", expectedDurationMs: 1000, memoryBytesHint: 0, cpuWeight: 1, ioWeight: 0, networkWeight: 0 });
                    if (admission.outcome !== "ADMIT") throw new Error("PANDAWA_RESOURCE_DENIED");
                    lease = admission.lease;
                }
                const value = await execute(Object.freeze({ ...node, dependencies: [...node.dependencies], authorityContext: null }));
                node.resultRef = id("pres"); node.status = "VERIFIED"; node.verificationState = "UNKNOWN";
                results.set(node.workId, Object.freeze({ workId: node.workId, producingEntity: node.ownerEntity, result: value, epistemic: "PROPOSED", authority: null }));
            } catch (error) {
                node.status = "FAILED"; results.set(node.workId, Object.freeze({ workId: node.workId, producingEntity: node.ownerEntity, error: String(error.message || error), epistemic: "UNKNOWN", authority: null }));
            } finally { if (lease && resourceGovernor) resourceGovernor.release(lease); active--; completed++; onEvent({ type: "work:done", node: { ...node } }); }
        }));
        for (const node of nodes) if (node.status === "QUEUED" && node.dependencies.every(d => results.has(d))) node.status = "READY";
        delegations += ready.length; if (delegations > graph.bounds.maxDelegations) throw new Error("PANDAWA_DELEGATION_BOUND_EXCEEDED");
    }
    return Object.freeze({ graphId: graph.graphId, results: [...results.values()], nodes: nodes.map(n => Object.freeze(n)), authority: null });
}

module.exports = Object.freeze({ GRAPH_TYPES, WORK_STATES, DEPTHS, DEFAULT_BOUNDS, selectTeam, createWorkGraph, runGraph });
