"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");
const orchestrator = require("./pandawaOrchestrator");
const scopes = require("./pandawaMemoryScope");

const EPISTEMIC = Object.freeze(["OBSERVED", "RETRIEVED", "INFERRED", "PREDICTED", "PROPOSED", "VERIFIED", "DISPUTED", "UNKNOWN"]);
const DISPUTE_STATES = Object.freeze(["MORE_EVIDENCE_REQUIRED", "TOOL_VERIFICATION_REQUIRED", "SPECIALIST_REVIEW_REQUIRED", "RESOLVED", "UNRESOLVED", "UNKNOWN"]);
const MAX_MEMBERS = 5;
function canon(v) { const r = identity.resolve(v); if (!r) throw new TypeError("PANDAWA_MEMBER_INVALID"); return r.id; }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function colony({ sessionId, ownerUserId = null, objective, members = [], lead = null } = {}) {
    const selected = [...new Set(members.length ? members.map(canon) : identity.records().map(r => r.id))];
    if (!selected.length || selected.length > MAX_MEMBERS) throw new RangeError("PANDAWA_COLONY_MEMBERS_INVALID");
    const leader = canon(lead || selected[0] || "pandawa:puntadewa"); if (!selected.includes(leader)) selected.unshift(leader);
    if (selected.length > MAX_MEMBERS) throw new RangeError("PANDAWA_COLONY_MEMBERS_INVALID");
    return { colonyId: id("pcol"), targetEntity: "pandawa:colony", sessionId: String(sessionId || ""), ownerUserId, objective: String(objective || "").slice(0, 4096), lead: leader, members: selected, workspace: { ...scopes.createWorkspace({ sessionId, objective }) }, createdAt: Date.now(), status: "ACTIVE", authority: null };
}
function addMember(c, member) { const idv = canon(member); if (!c.members.includes(idv)) { if (c.members.length >= MAX_MEMBERS) throw new RangeError("PANDAWA_COLONY_FULL"); c.members.push(idv); } return c; }
function removeMember(c, member) { const idv = canon(member); if (idv === c.lead) throw new Error("PANDAWA_COLONY_LEAD_REQUIRED"); c.members = c.members.filter(x => x !== idv); return c; }
function memberOutput(c, { entity, result, epistemic = "PROPOSED", evidenceRefs = [], uncertainty = [] } = {}) { const producingEntity = canon(entity); if (!c.members.includes(producingEntity)) throw new Error("PANDAWA_MEMBER_NOT_IN_COLONY"); if (!EPISTEMIC.includes(epistemic)) throw new TypeError("PANDAWA_EPISTEMIC_INVALID"); const output = Object.freeze({ producingEntity, sessionId: c.sessionId, workId: id("pwrk"), result, epistemic, evidenceRefs: [...evidenceRefs].slice(0, 32), uncertainty: [...uncertainty].slice(0, 32), createdAt: Date.now(), authority: null }); c.workspace.memberOutputs.push(output); return output; }
function dispute(c, { issue, positions = [], evidence = [], resolutionState = "UNKNOWN", openQuestions = [] } = {}) { if (!DISPUTE_STATES.includes(resolutionState)) throw new TypeError("PANDAWA_DISPUTE_STATE_INVALID"); const d = Object.freeze({ disputeId: id("pdis"), issue: String(issue || "").slice(0, 4096), positions: positions.slice(0, MAX_MEMBERS), evidence: evidence.slice(0, 32), confidence: null, openQuestions: openQuestions.slice(0, 32), resolutionState, createdAt: Date.now() }); c.workspace.disputes.push(d); return d; }
function synthesize(c, { result, uncertainty = [], evidenceRefs = [] } = {}) { const unresolved = c.workspace.disputes.some(d => !["RESOLVED"].includes(d.resolutionState)); const output = Object.freeze({ producingEntity: c.lead, sessionId: c.sessionId, result, epistemic: unresolved ? "UNKNOWN" : "PROPOSED", uncertainty: [...uncertainty, ...(unresolved ? ["COLONY_DISPUTE_UNRESOLVED"] : [])], evidenceRefs: evidenceRefs.slice(0, 32), consensus: c.workspace.memberOutputs.length > 0, authority: null, createdAt: Date.now() }); c.workspace.synthesis = output; return output; }
function resolveMemberTarget(c, text) { const target = identity.resolveTarget(text); return c.members.includes(target.id) ? Object.freeze({ ...target, colonyId: c.colonyId, sessionId: c.sessionId }) : null; }
function plan(c, options = {}) { return orchestrator.createWorkGraph({ ...options, type: options.type || "COLONY", objective: c.objective, members: c.members }); }
module.exports = Object.freeze({ EPISTEMIC, DISPUTE_STATES, createColony: colony, addMember, removeMember, recordMemberOutput: memberOutput, createDispute: dispute, synthesize, resolveMemberTarget, plan });
