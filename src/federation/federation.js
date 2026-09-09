"use strict";

/**
 * WAVE 6 L4 — External Capability, MCP & Skill Federation.
 *
 * GOAL: discover external capabilities safely without converting the
 * internet into an implicit root plugin store.
 *
 * LAWS:
 *   SKILL DISCOVERY != SKILL ENABLEMENT
 *   MCP DISCOVERY != CAPABILITY ENABLEMENT
 *   PLUGIN INSTALLATION != EXECUTION AUTHORITY
 *   PANDAWA RECOMMENDATION != INSTALL AUTHORITY
 *
 * Lifecycle: DISCOVERED -> QUARANTINED -> INSPECTED -> VALIDATED -> ENABLED
 *            | REJECTED / REVOKED / EXPIRED
 * Every candidate carries a provenance record (source, publisher, license,
 * version, digest, permissions). Digest pinning: validation binds the exact
 * artifact digest; later mutation -> candidate reverts to QUARANTINED.
 * Enablement is per-tool and time-bounded. The canonical Authority plane
 * stays the only grantor — enablement is intake metadata, not a grant.
 */

const crypto = require("node:crypto");
const { meshFailure, MESH_ERRORS } = require("../mesh/errors");
const { sha256Hex } = require("../mesh/canonical");

const LIFECYCLE = Object.freeze([
    "DISCOVERED", "QUARANTINED", "INSPECTED", "VALIDATED", "ENABLED",
    "REJECTED", "REVOKED", "EXPIRED"
].reduce((m, s) => (m[s] = s, m), {}));

const TRANSITIONS = Object.freeze({
    DISCOVERED: ["QUARANTINED", "REJECTED"],
    QUARANTINED: ["INSPECTED", "REJECTED", "EXPIRED"],
    INSPECTED: ["VALIDATED", "REJECTED", "EXPIRED"],
    VALIDATED: ["ENABLED", "REJECTED", "EXPIRED", "QUARANTINED"],
    ENABLED: ["REVOKED", "EXPIRED", "QUARANTINED"],
    REJECTED: [], REVOKED: [], EXPIRED: []
});

const DEFAULTS = Object.freeze({
    maxCandidates: 256,
    maxCandidatesPerSource: 32,
    enablementTtlMs: 24 * 3600 * 1000,
    maxProvenanceFields: 24
});

/** Hard security inspection rules — ANY hit fails inspection. */
const INSPECTION_RULES = Object.freeze([
    { id: "postinstall_hook", pattern: /postinstall|preinstall|prepare\s*['"]?\s*:/i, reason: "install-time script execution" },
    { id: "dynamic_code", pattern: /eval\(|new Function\(|child_process\.exec/i, reason: "dynamic code / shell execution in package surface" },
    { id: "obfuscated_payload", pattern: /\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){8,}|base64,\s*[A-Za-z0-9+/=]{200,}/i, reason: "obfuscated payload" },
    { id: "secret_access", pattern: /process\.env\.(?!NODE_ENV)[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i, reason: "direct secret environment access" }
]);

class ExternalCapabilityFederation {
    constructor({ config = {}, nowMs = () => Date.now() } = {}) {
        this.config = Object.freeze({ ...DEFAULTS, ...config });
        this.nowMs = nowMs;
        /** candidateId -> candidate */
        this._candidates = new Map();
        /** sourceId -> count (bounded per source) */
        this._perSource = new Map();
        /** enabled tool grants: toolKey -> { expiresAtMs, candidateId } */
        this._enabledTools = new Map();
    }

    /** Intake: discovery creates a QUARANTINED candidate with provenance. */
    discover({ source, sourceType = "mcp", publisher = "unknown", name, version = "0.0.0", license = null, artifactDigest, permissions = {}, artifactSurface = "" } = {}) {
        if (typeof source !== "string" || source.length === 0 || source.length > 256) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "source required");
        if (typeof name !== "string" || name.length === 0 || name.length > 128) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "name required");
        if (typeof artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(artifactDigest)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "artifactDigest must be 64 hex (digest pinning mandatory)");
        const perSource = this._perSource.get(source) ?? 0;
        if (perSource >= this.config.maxCandidatesPerSource) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, `source '${source.slice(0, 48)}' at candidate cap`);
        if (this._candidates.size >= this.config.maxCandidates) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "candidate table full");
        const provenance = this._buildProvenance({ source, sourceType, publisher, name, version, license, artifactDigest, permissions });
        const candidateId = `dcap-${crypto.randomBytes(16).toString("hex")}`;
        const candidate = {
            candidateId,
            provenance,
            state: "QUARANTINED",
            inspectionFindings: [],
            validatedToolDigests: new Map(), // toolName -> digest at validation time
            enabledTools: new Set(),
            discoveredAtMs: this.nowMs(),
            expiresAtMs: this.nowMs() + this.config.enablementTtlMs * 7,
            quarantineReason: "intake quarantine (SKILL DISCOVERY != SKILL ENABLEMENT)"
        };
        this._candidates.set(candidateId, candidate);
        this._perSource.set(source, perSource + 1);
        return this.snapshot(candidateId);
    }

    _buildProvenance({ source, sourceType, publisher, name, version, license, artifactDigest, permissions }) {
        const p = {
            source: String(source).slice(0, 256),
            sourceType: String(sourceType).slice(0, 32),
            publisher: String(publisher).slice(0, 128),
            name: String(name).slice(0, 128),
            version: String(version).slice(0, 64),
            license: license === null ? null : String(license).slice(0, 128),
            artifactDigest,
            retrievedAtMs: this.nowMs(),
            permissions: {}
        };
        const permKeys = Object.keys(permissions ?? {});
        if (permKeys.length > 12) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "permissions exceed 12 entries");
        for (const k of permKeys) {
            const v = permissions[k];
            p.permissions[String(k).slice(0, 32)] = Array.isArray(v) ? Object.freeze(v.map(x => String(x).slice(0, 128)).slice(0, 16)) : String(v ?? "").slice(0, 128);
        }
        return Object.freeze(p);
    }

    /** Inspection: adversarial surface scan. ANY rule hit -> REJECTED. */
    inspect(candidateId, { artifactSurface = "" } = {}) {
        const c = this._require(candidateId, "QUARANTINED");
        const surface = String(artifactSurface ?? "").slice(0, 64 * 1024);
        const findings = [];
        for (const rule of INSPECTION_RULES) {
            if (rule.pattern.test(surface)) findings.push({ rule: rule.id, reason: rule.reason });
        }
        // license missing -> rejected
        if (c.provenance.license === null) findings.push({ rule: "license_missing", reason: "no license declared" });
        c.inspectionFindings = findings;
        if (findings.length > 0) {
            this._transition(c, "REJECTED", findings.map(f => f.rule).join(","));
            return this.snapshot(candidateId);
        }
        this._transition(c, "INSPECTED");
        return this.snapshot(candidateId);
    }

    /**
     * Validation: digest pinning of the artifact + per-tool digests.
     * A later tool mutation (digest change) reverts the candidate to QUARANTINED.
     */
    validate(candidateId, { toolDigests = {} } = {}) {
        const c = this._require(candidateId, "INSPECTED");
        const entries = Object.entries(toolDigests ?? {});
        if (entries.length === 0 || entries.length > 32) throw meshFailure(MESH_ERRORS.BOUNDS_EXCEEDED, "toolDigests must have 1..32 entries");
        for (const [tool, digest] of entries) {
            if (!/^[0-9a-f]{64}$/.test(String(digest))) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `tool digest for '${String(tool).slice(0, 48)}' must be 64 hex`);
        }
        c.validatedToolDigests = new Map(entries.map(([t, d]) => [String(t).slice(0, 128), String(d)]));
        c.validatedAtMs = this.nowMs();
        this._transition(c, "VALIDATED");
        return this.snapshot(candidateId);
    }

    /**
     * Per-tool enablement — bounded TTL, per tool. ENABLEMENT IS NOT A GRANT:
     * callers still route execution through the canonical Authority plane.
     */
    enableTool(candidateId, { toolName } = {}) {
        const c = this._require(candidateId, "VALIDATED");
        const tool = String(toolName ?? "").slice(0, 128);
        const pinned = c.validatedToolDigests.get(tool);
        if (!pinned) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `tool '${tool}' was not part of validation`);
        c.enabledTools.add(tool);
        const toolKey = `${c.candidateId}:${tool}`;
        this._enabledTools.set(toolKey, { expiresAtMs: this.nowMs() + this.config.enablementTtlMs, candidateId });
        this._transition(c, "ENABLED");
        return this.snapshot(candidateId);
    }

    /**
     * Tool mutation check (MCP server changed a tool after validation):
     * digest differs from the pinned one -> candidate reverts to QUARANTINED,
     * all enablements void.
     */
 checkToolIntegrity(candidateId, { toolName, currentDigest } = {}) {
 const c = this._require(candidateId, "ENABLED");
 const tool = String(toolName ?? "").slice(0, 128);
 const pinned = c.validatedToolDigests.get(tool);
 if (pinned && pinned !== String(currentDigest)) {
 c.enabledTools.clear();
 // void the enablement grant itself (tool integrity broken)
 this._enabledTools.delete(`${c.candidateId}:${tool}`);
 this._transition(c, "QUARANTINED", `tool '${tool}' mutated after validation`);
 const snap = this.snapshot(candidateId);
 return Object.freeze({ ...snap, mutationDetected: { tool, pinnedDigest: pinned, currentDigest: String(currentDigest).slice(0, 64) } });
 }
 return this.snapshot(candidateId);
 }

    revoke(candidateId, { reason = "revoked" } = {}) {
        const c = this._require(candidateId, null);
        c.enabledTools.clear();
        this._transition(c, "REVOKED", reason);
        return this.snapshot(candidateId);
    }

    /** Skill federation: skills are reasoning/selection hints, never grants. */
    registerSkill({ name, scope = "global", source = "local", digest = null } = {}) {
        if (typeof name !== "string" || name.length === 0 || name.length > 128) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "skill name required");
        if (!["global", "node-local", "pandawa-specific", "task-local"].includes(scope)) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `unknown skill scope '${String(scope).slice(0, 32)}'`);
        const skillId = `dskill-${crypto.randomBytes(12).toString("hex")}`;
        return Object.freeze({
            skillId, name: name.slice(0, 128), scope,
            source: String(source).slice(0, 256),
            digest: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
            law: "SKILL != CAPABILITY — a skill influences reasoning/tool selection; it cannot grant permission",
            registeredAtMs: this.nowMs()
        });
    }

    /**
     * Pandawa acquisition analysis — advisory only. Structurally incapable of
     * enabling anything: returns recommendations for the human/authority lane.
     */
    pandawaAnalysis({ janaka = null, nakula = null, sadewa = null, werkudara = null, puntadewa = null } = {}) {
        return Object.freeze({
            technicalFit: boundedNote(janaka), capabilityData: boundedNote(nakula),
            provenanceLicense: boundedNote(sadewa), securityInspection: boundedNote(werkudara),
            synthesis: boundedNote(puntadewa),
            law: "PANDAWA RECOMMENDATION != INSTALL AUTHORITY — advisory metadata only; enablement requires the governed pipeline + Authority"
        });
    }

    isToolEnabled(candidateId, toolName) {
        const key = `${candidateId}:${String(toolName ?? "").slice(0, 128)}`;
        const grant = this._enabledTools.get(key);
        if (!grant) return false;
        if (grant.expiresAtMs <= this.nowMs()) { this._enabledTools.delete(key); return false; }
        return true;
    }

    snapshot(candidateId) {
        const c = this._candidates.get(candidateId);
        return c ? Object.freeze({
            candidateId: c.candidateId,
            provenance: c.provenance,
            state: c.state,
            inspectionFindings: Object.freeze([...c.inspectionFindings]),
            enabledTools: Object.freeze([...c.enabledTools]),
            validatedTools: Object.freeze([...c.validatedToolDigests.keys()]),
            quarantineReason: c.quarantineReason ?? null,
            expiresAtMs: c.expiresAtMs,
            ...(c.mutationDetected ? { mutationDetected: c.mutationDetected } : {})
        }) : null;
    }

    size() { return this._candidates.size; }

    _require(candidateId, expectedState) {
        const c = this._candidates.get(candidateId);
        if (!c) throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, "unknown candidate");
        if (expectedState && c.state !== expectedState) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `candidate in state '${c.state}', expected '${expectedState}'`);
        }
        return c;
    }

    _transition(c, to, details = null) {
        if (!TRANSITIONS[c.state]?.includes(to)) {
            throw meshFailure(MESH_ERRORS.MESSAGE_MALFORMED, `illegal lifecycle transition ${c.state} -> ${String(to).slice(0, 24)}`);
        }
        c.state = to;
        if (details) c.quarantineReason = String(details).slice(0, 300);
    }
}

function boundedNote(v) {
    return v === null || v === undefined ? null : Object.freeze({ note: String(v).slice(0, 500) });
}

module.exports = Object.freeze({ ExternalCapabilityFederation, LIFECYCLE, TRANSITIONS, INSPECTION_RULES, DEFAULTS });
