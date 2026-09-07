"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");

const ORIGINS = Object.freeze(["CURATED", "LEARNED", "EVOLVED", "EXPERIMENTAL", "QUARANTINED"]);
const MAX_SKILLS = 256;
const MAX_EVIDENCE = 32;
const CAPABILITY_KEYS = /["'](?:authority|grant|root|actuation|execute)(?:["']|\\s*:)/i;

function id() { return `pskill_${crypto.randomUUID().replaceAll("-", "")}`; }
function owner(value) { const raw = String(value ?? "").toLowerCase(); if (raw === "damar") return "damar"; return identity.assertPandawaId(value); }
function text(value, name, max = 4096) { if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`${name}_INVALID`); return value.trim(); }
function assertSafe(value) { if (CAPABILITY_KEYS.test(JSON.stringify(value ?? {}))) throw new Error("PANDAWA_SKILL_AUTHORITY_FIELD_REJECTED"); }

class PandawaSkillBridge {
    constructor({ capabilityRegistry = null, evolutionAuthority = null, maxSkills = MAX_SKILLS } = {}) { this.capabilityRegistry = capabilityRegistry; this.evolutionAuthority = evolutionAuthority; this.maxSkills = maxSkills; this.skills = new Map(); this.candidates = new Map(); }
    register({ skillId = id(), ownerEntity, compatibleEntities = [], version = "0.1.0", origin = "CURATED", maturity = "EXPERIMENTAL", requiredCapabilities = [], evidenceRefs = [], procedure, metadata = {} } = {}) {
        const ownerEntityId = owner(ownerEntity); if (!ORIGINS.includes(origin)) throw new TypeError("SKILL_ORIGIN_INVALID");
        if (this.skills.size >= this.maxSkills && !this.skills.has(skillId)) throw new RangeError("SKILL_BOUND_EXCEEDED");
        const record = { skillId: text(skillId, "SKILL_ID", 128), ownerEntity: ownerEntityId, compatibleEntities: [...new Set(compatibleEntities.map(owner))].slice(0, 5), version: text(version, "SKILL_VERSION", 64), origin, maturity: text(maturity, "SKILL_MATURITY", 32), requiredCapabilities: [...new Set(requiredCapabilities.map(v => text(v, "CAPABILITY_ID", 128)))].slice(0, 32), evidenceRefs: evidenceRefs.slice(0, MAX_EVIDENCE), procedure: text(procedure, "SKILL_PROCEDURE"), metadata: { ...metadata }, createdAt: Date.now(), updatedAt: Date.now(), capabilityGrant: null };
        assertSafe(record); this.skills.set(record.skillId, Object.freeze(record)); return this.describe(record.skillId);
    }
    describe(skillId) { const s = this.skills.get(skillId); return s ? Object.freeze({ ...s, compatibleEntities: [...s.compatibleEntities], requiredCapabilities: [...s.requiredCapabilities], evidenceRefs: [...s.evidenceRefs], metadata: { ...s.metadata } }) : null; }
    list(entityId = null) { const e = entityId ? owner(entityId) : null; return [...this.skills.values()].filter(s => !e || s.ownerEntity === e || s.compatibleEntities.includes(e)).map(s => this.describe(s.skillId)); }
    observe({ skillId, result, evidenceRefs = [], success = false } = {}) { if (!this.skills.has(skillId)) throw new Error("SKILL_NOT_FOUND"); if (!success) return { accepted: false, reason: "INSUFFICIENT_SUCCESS" }; const candidate = { candidateId: id(), skillId, result: String(result ?? "").slice(0, 4096), evidenceRefs: evidenceRefs.slice(0, MAX_EVIDENCE), observations: 1, confidence: 0.5, state: "CANDIDATE", authority: null, createdAt: Date.now() }; this.candidates.set(candidate.candidateId, candidate); return Object.freeze({ ...candidate }); }
    async propose(candidateId, { actor = "pandawa-learning" } = {}) { const candidate = this.candidates.get(candidateId); if (!candidate) throw new Error("SKILL_CANDIDATE_NOT_FOUND"); candidate.observations++; candidate.confidence = Math.min(0.99, candidate.confidence + 0.1); if (this.evolutionAuthority?.proposeEvolution) return this.evolutionAuthority.proposeEvolution({ proposalId: `skill.${candidate.skillId}.${candidate.candidateId}`, kind: "skill_promotion", problem: "repeated bounded success", proposedChange: { skillId: candidate.skillId, candidateId, confidence: candidate.confidence, evidenceRefs: candidate.evidenceRefs }, createdBy: actor }); return Object.freeze({ ...candidate, state: "PROMOTION_PROPOSED", authority: null }); }
    async promote(candidateId, { validator = null } = {}) { const candidate = this.candidates.get(candidateId); if (!candidate) throw new Error("SKILL_CANDIDATE_NOT_FOUND"); if (!validator || typeof validator.validate !== "function") return Object.freeze({ promoted: false, state: "QUARANTINED", reason: "SANDBOX_VALIDATION_REQUIRED", authority: null }); const check = await validator.validate(this.describe(candidate.skillId), candidate); if (check?.ok !== true) return Object.freeze({ promoted: false, state: "QUARANTINED", reason: "SANDBOX_REJECTED", authority: null }); const prior = this.skills.get(candidate.skillId); this.skills.set(candidate.skillId, Object.freeze({ ...prior, origin: "LEARNED", maturity: "VALIDATED", updatedAt: Date.now(), evidenceRefs: [...new Set([...prior.evidenceRefs, ...candidate.evidenceRefs])].slice(0, MAX_EVIDENCE), capabilityGrant: null })); return Object.freeze({ promoted: true, skill: this.describe(candidate.skillId), authority: null }); }
}

module.exports = Object.freeze({ ORIGINS, PandawaSkillBridge });
