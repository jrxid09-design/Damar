/**
 * MODEL OTORITAS V1 — status, transisi, pabrik objek kanonik.
 *
 * REQUEST  != GRANT
 * PROPOSAL != AUTHORITY
 * GRANT hanya lahir dari: (a) attenuateGrant sah, atau
 *                         (b) OwnerRatification APPROVED (root baru).
 */

const { canonicalCapabilityId, canonicalTokenList,
        canonicalRestrictionSet, restoreCanonicalRestrictionSet,
        RESTRICTION_KINDS } = require("./canonical");
const { canonicalJson, sha256, deepFreeze } = require("./canonical");

const STATUS = Object.freeze({
    ACTIVE: "ACTIVE", SUSPENDED: "SUSPENDED",
    REVOKED: "REVOKED", EXPIRED: "EXPIRED", EXHAUSTED: "EXHAUSTED"
});

const TRANSITIONS = Object.freeze({
    "ACTIVE->SUSPENDED": true,
    "SUSPENDED->ACTIVE": true,
    "ACTIVE->REVOKED": true,
    "ACTIVE->EXPIRED": true,
    "ACTIVE->EXHAUSTED": true,
    "SUSPENDED->REVOKED": true,
    "SUSPENDED->EXPIRED": true
});

function canTransition(from, to) {
    return Boolean(TRANSITIONS[`${from}->${to}`]);
}

const DENY_CODES = Object.freeze([
    "CAP_NOT_FOUND","CAP_INACTIVE","CAP_REVOKED","CAP_EXPIRED",
    "CAP_EXHAUSTED","CAP_GENERATION_STALE","CAP_ACTION_DENIED",
    "CAP_SCOPE_MISMATCH","CAP_PURPOSE_MISMATCH","CAP_IDENTITY_MISMATCH",
    "CAP_RESTRICTION_FAILED","CAP_BUDGET_EXHAUSTED","CAP_DELEGATION_DENIED",
    "CAP_RATIFICATION_REQUIRED","CAP_MALFORMED",
    "CAP_RATIFICATION_CONSUMED","CAP_DELEGATION_BUDGET_EXHAUSTED"
]);

/**
 * Normalisasi RestrictionSet untuk buildGrant (internal).
 *
 * Bentuk canonical object yang sudah pernah dipersist (hasil
 * attenuateGrant / hydrate internal) direhidrasi via jalur TRUSTED
 * restoreCanonicalRestrictionSet(). Input eksternal lain tetap masuk
 * canonicalRestrictionSet() dan object polos DITOLAK (L-D1 fail-closed).
 */
function normalizeRestrictionsForBuild(input) {
    if (input && typeof input === "object" &&
        !Array.isArray(input) && !(input instanceof Set) &&
        typeof input.kind === "string") {
        return restoreCanonicalRestrictionSet(input);
    }
    return canonicalRestrictionSet(input);
}

/** Pabrik grant ternormalisasi — dipakai attenuation & ratification. */
function buildGrant({
    capabilityId, kind, subject, issuer,
    actions, scope = [], allowedPurposes = [],
    restrictions = null,
    maxExecutions = null,               // null = unlimited (root saja)
    issuedAt, notBefore = null, expiresAt = null,
    generation = 0,
    delegationDepth = 0, remainingDelegationDepth = 0,
    parentCapabilityId = null, rootCapabilityId = capabilityId,
    purpose = null,
    identityBinding = null,             // {channels?,sessionIds?,principals?}
    ratificationId = null,
    extra = null
}) {

    const id = canonicalCapabilityId(capabilityId);

    if (!["root", "delegated"].includes(kind)) {
        throw new AuthorityMalformed("kind tidak sah: " + kind);
    }
    if (!subject || typeof subject !== "string") {
        throw new AuthorityMalformed("subject wajib");
    }

    const grant = {
        capabilityId: id,
        kind,
        subject,
        issuer: String(issuer ?? "unknown").slice(0, 120),
        actions: canonicalTokenList(actions, "actions"),
        scope: canonicalTokenList(scope, "scope"),
        allowedPurposes: canonicalTokenList(allowedPurposes, "allowedPurposes"),
        restrictions: normalizeRestrictionsForBuild(restrictions),
        maxExecutions: normalizeBudget(maxExecutions, kind),
        usedExecutions: 0,
        purpose: purpose ? String(purpose).slice(0, 200) : null,
        identityBinding: normalizeIdentityBinding(identityBinding),
        issuedAt: issuedAt ?? new Date().toISOString(),
        notBefore: notBefore ? String(notBefore) : null,
        expiresAt: expiresAt ? String(expiresAt) : null,
        status: STATUS.ACTIVE,
        generation: Math.max(0, Math.floor(generation)),
        delegationDepth: Math.max(0, Math.floor(delegationDepth)),
        remainingDelegationDepth: Math.max(0,
            Math.floor(remainingDelegationDepth)),
        parentCapabilityId: parentCapabilityId ?? null,
        rootCapabilityId: rootCapabilityId ? 
            canonicalCapabilityId(rootCapabilityId) : id,
        ratificationId: ratificationId ?? null,
        extra: extra ? deepFreeze(JSON.parse(JSON.stringify(extra))) : null
    };

    return deepFreeze(grant);
}

function normalizeBudget(maxExecutions, kind) {
    if (maxExecutions === null || maxExecutions === undefined) {
        if (kind === "delegated") {
            throw new AuthorityMalformed(
                "delegated grant wajib punya budget eksekusi deterministik");
        }
        return null;                        // root unlimited
    }
    const n = Number(maxExecutions);
    if (!Number.isInteger(n) || n <= 0) {
        throw new AuthorityMalformed("maxExecutions harus integer > 0");
    }
    return n;
}

function normalizeIdentityBinding(binding) {
    if (binding === undefined || binding === null) return null;
    const norm = {};
    for (const key of ["channels", "sessionIds", "principals"]) {
        const list = binding[key];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
            throw new AuthorityMalformed(`identityBinding.${key} harus array`);
        }
        norm[key] = Object.freeze([...new Set(
            list.map(x => String(x).trim().toLowerCase()).filter(Boolean))]);
    }
    return Object.keys(norm).length ? deepFreeze(norm) : null;
}

class AuthorityMalformed extends Error {
    constructor(message) {
        super(message);
        this.name = "AuthorityMalformed";
        this.reasonCode = "CAP_MALFORMED";
    }
}

/* ------------------------- PROPOSAL / RATIFICATION ----------------------- */

const EVOLUTION_STATUS = Object.freeze([
    "DRAFT","RESEARCHING","CANDIDATE_READY","AWAITING_RATIFICATION",
    "APPROVED","REJECTED","APPLIED","ROLLED_BACK"
]);

/**
 * ProposalId WAJIB slug aman (§path-safety): lowercase [a-z0-9._-],
 * tidak diawali/diakhiri separator, tanpa '..' — dipakai langsung
 * sebagai nama berkas di AetherSelf/evolution/proposals.
 */
const PROPOSAL_ID_RE =
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*$/;

function isValidProposalId(id) {
    return typeof id === "string" &&
        id.length > 0 && id.length <= 120 &&
        PROPOSAL_ID_RE.test(id);
}

function evolutionDigest(proposalCore) {
    // Digest mengikat REVISI proposal: perubahan material apapun pada
    // core menghasilkan digest berbeda -> ratifikasi lama stale (§E).
    return sha256(canonicalJson(proposalCore));
}

function buildEvolutionProposal({
    proposalId, createdBy, kind = "architectural_change",
    problem, hypothesis = "", proposedChange,
    affectedSubsystems = [], expectedBenefit = "",
    risk = "", requiredCapabilities = [], migrationNeeded = false,
    rollbackPlan = "", testPlan = "", evidenceRefs = [],
    requestedAuthority = null,          // utk kind authority_expansion
    at
}) {
    if (!isValidProposalId(proposalId)) {
        throw new AuthorityMalformed(
            "proposalId harus slug aman [a-z0-9._-], maks 120, " +
            "tanpa '..' atau separator di tepi");
    }
    if (!problem || !proposedChange) {
        throw new AuthorityMalformed("proposal wajib punya problem & proposedChange");
    }
    const core = {
        proposalId: String(proposalId).slice(0, 120),
        createdBy: String(createdBy ?? "unknown").slice(0, 80),
        kind: String(kind).slice(0, 40),
        problem: String(problem).slice(0, 2000),
        hypothesis: String(hypothesis).slice(0, 2000),
        proposedChange: String(proposedChange).slice(0, 4000),
        affectedSubsystems: [...affectedSubsystems].slice(0, 20),
        expectedBenefit: String(expectedBenefit).slice(0, 1000),
        risk: String(risk).slice(0, 1000),
        requiredCapabilities:
            requiredCapabilities.map(c => canonicalCapabilityId(c)),
        migrationNeeded: Boolean(migrationNeeded),
        rollbackPlan: String(rollbackPlan).slice(0, 1000),
        testPlan: String(testPlan).slice(0, 1000),
        evidenceRefs: [...evidenceRefs].slice(0, 30),
        requestedAuthority: requestedAuthority ?
            JSON.parse(JSON.stringify(requestedAuthority)) : null
    };
    return Object.freeze({
        ...core,
        revision: 1,
        digest: evolutionDigest(core),
        status: "DRAFT",
        createdAt: at ?? new Date().toISOString()
    });
}

function buildRatification({
    ratificationId, proposalId, ownerIdentity, decision,
    approvedAuthority = null, expiryAt = null, at,
    supersedes = null
}) {
    if (!["APPROVED", "REJECTED"].includes(decision)) {
        throw new AuthorityMalformed("decision ratifikasi harus APPROVED/REJECTED");
    }
    return Object.freeze({
        ratificationId: String(ratificationId).slice(0, 120),
        proposalId: String(proposalId).slice(0, 120),
        ownerIdentity: String(ownerIdentity ?? "owner").slice(0, 120),
        decision,
        approvedAuthority: approvedAuthority ?
            JSON.parse(JSON.stringify(approvedAuthority)) : null,
        expiryAt: expiryAt ? String(expiryAt) : null,
        supersedes: supersedes ?? null,
        at: at ?? new Date().toISOString()
        // CATATAN: proposalDigest diisi Registry saat apply (bind revisi).
    });
}

module.exports = {
    STATUS, TRANSITIONS, canTransition, DENY_CODES,
    buildGrant, normalizeBudget, normalizeIdentityBinding,
    normalizeRestrictionsForBuild,
    AuthorityMalformed,
    EVOLUTION_STATUS, buildEvolutionProposal, evolutionDigest,
    buildRatification,
    PROPOSAL_ID_RE, isValidProposalId
};
