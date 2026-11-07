"use strict";

const identity = require("./pandawaIdentity");
const MAX_ITEMS = 32;
const MAX_BYTES = 32768;
const SECRET_KEY = /(secret|password|passwd|token|api[_-]?key|credential|vault)/i;

function namespaceFor(entity) { return identity.assertPandawaId(entity); }
function bounded(value, name, max = MAX_ITEMS) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > max) throw new TypeError(`${name}_INVALID`);
    return value.map(v => typeof v === "string" ? v.slice(0, 2048) : JSON.parse(JSON.stringify(v)));
}
function assertSafe(value) {
    const serialized = JSON.stringify(value ?? {});
    if (SECRET_KEY.test(serialized)) throw new Error("PANDAWA_CONTEXT_SECRET_REJECTED");
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) throw new RangeError("PANDAWA_CONTEXT_TOO_LARGE");
}
function createContextProjection({ sourceEntity, targetEntity, sessionId, objective, artifactRefs = [], facts = [], evidence = [], assumptions = [], constraints = [], decisionHistory = [] } = {}) {
    const source = namespaceFor(sourceEntity); const target = namespaceFor(targetEntity);
    const projection = { sourceEntity: source, targetEntity: target, sessionId: String(sessionId || "").slice(0, 256), objective: String(objective || "").slice(0, 4096), artifactRefs: bounded(artifactRefs, "ARTIFACT_REFS"), facts: bounded(facts, "FACTS"), evidence: bounded(evidence, "EVIDENCE"), assumptions: bounded(assumptions, "ASSUMPTIONS"), constraints: bounded(constraints, "CONSTRAINTS"), decisionHistory: bounded(decisionHistory, "DECISION_HISTORY"), createdAt: Date.now(), sourceScope: source, targetScope: target, authority: null };
    assertSafe(projection);
    return Object.freeze(projection);
}
function createWorkspace({ sessionId, objective } = {}) { return Object.freeze({ workspaceId: `pws_${Date.now()}_${Math.random().toString(16).slice(2)}`, sessionId: String(sessionId || "").slice(0, 256), objective: String(objective || "").slice(0, 4096), temporary: true, facts: [], assumptions: [], evidence: [], proposals: [], disputes: [], openQuestions: [], decisions: [], memberOutputs: [], synthesis: null, authority: null }); }
async function proposePromotion(workspace, { governor, entity, reason = "pandawa workspace promotion" } = {}) {
    if (!governor || typeof governor.propose !== "function") throw new TypeError("MEMORY_GOVERNOR_REQUIRED");
    const writer = namespaceFor(entity); const payload = { namespace: writer, workspaceId: workspace.workspaceId, source: "pandawa-workspace", content: workspace.synthesis || workspace.decisions };
    assertSafe(payload);
    return governor.propose({ kind: "memory", payload, memoryType: "workspace", writer, role: "runtime", reason });
}
function canRead({ requesterEntity, sourceEntity, projected = false } = {}) { return projected || namespaceFor(requesterEntity) === namespaceFor(sourceEntity); }
module.exports = Object.freeze({ MAX_ITEMS, MAX_BYTES, namespaceFor, createContextProjection, createWorkspace, proposePromotion, canRead });
