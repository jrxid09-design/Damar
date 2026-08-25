const crypto = require("node:crypto");

/**
 * SUBSTRATE ROUTER (§39/§54/§55) + COGNITIVE REQUEST / PROPOSAL
 * (§40–§42, §97).
 *
 * C0: router HANYA mengobservasi & mencatat pergantian substrate —
 * tidak ada policy switching otonom. Identitas Aether ≠ model.
 *
 * CognitiveRequest memakai jalur identitas kanonik foundation dengan
 * capabilitySet=[] DIBEKUKAN (menggunakan ulang invariant M-1):
 * kognisi internal ≠ otoritas aksi. Tidak ada tools.
 */

const { canonicalJson } = require("../core/envelope");

function newEpochId() {
    return `sub-${crypto.randomUUID()}`;
}

/** Deskriptor substrate sah; tanpa klaim kualitas. */
function normalizeDescriptor(descriptor = {}) {
    return Object.freeze({
        provider: String(descriptor.provider ?? "unknown").slice(0, 60),
        modelId: String(descriptor.modelId ?? "unknown").slice(0, 120),
        family: descriptor.family ? String(descriptor.family).slice(0, 60) : null,
        contextWindow: Number.isFinite(descriptor.contextWindow)
            ? descriptor.contextWindow : null,
        local: Boolean(descriptor.local),
        substrateEpochId: descriptor.substrateEpochId ?? newEpochId()
    });
}

/**
 * CognitiveRequest — permintaan KOGNISI internal. Zero action authority:
 *   exec.capabilitySet = [] dibekukan via Authorization.identity()
 *   tools = [] (tidak ada disclosure sama sekali)
 */
function makeCognitiveRequest({ purpose, Authorization, selfStateRef = null,
                                workspaceRefs = [], constraints = null,
                                maxTokens = 512, at }) {

    const ALLOWED_PURPOSES = ["INTERPRET", "SUMMARIZE", "PREDICT",
                              "REFLECT", "COMPARE", "EXPLAIN"];

    if (!ALLOWED_PURPOSES.includes(purpose)) {
        throw new Error(`ACC: tujuan kognitif tidak sah: '${purpose}'`);
    }

    const capabilitySet = Object.freeze([]);           // LOCKED-EMPTY

    const exec = Authorization.identity({
        role: "user",                                  // least privilege
        channel: "cognition",
        sessionId: "acc-cognitive",
        capabilitySet                                  // → frozen [] di identity()
    });

    // Bukti kanonik: set tetap locked-empty SETELAH identity().
    if (!Array.isArray(exec.capabilitySet) || exec.capabilitySet.length !== 0) {
        throw new Error("ACC: capabilitySet kognitif wajib locked-empty");
    }

    return Object.freeze({
        cognitiveRequestId: `creq-${crypto.randomUUID()}`,
        purpose,
        timestamp: at,
        selfStateRef,
        workspaceRefs: [...workspaceRefs].slice(0, 20),
        worldEvidenceRefs: [],
        autobiographicalRefs: [],
        constraints: constraints ?? null,
        expectedOutputSchema: "acc.proposal.v1",
        maxTokens,
        substratePreference: null,
        tools: Object.freeze([]),
        exec
    });

}

/**
 * CognitiveProposal — output model adalah HIPOTESIS, bukan perintah.
 * Tidak membawa field eksekusi; reducer yang memutuskan efek turunannya.
 */
function makeProposal({ cognitiveRequestId, substrateId, type, claims = [],
                        confidence, evidenceRefs = [], generatedAt }) {

    return Object.freeze({
        proposalId: `prop-${crypto.randomUUID()}`,
        cognitiveRequestId,
        substrateId,
        type: String(type).slice(0, 40),
        claims: claims.slice(0, 20).map(c => structured(c)),
        confidence: clamp01(confidence),
        evidenceRefs: [...evidenceRefs].slice(0, 30),
        epistemicClass: "MODEL_HYPOTHESIS",
        generatedAt
    });

}

/** Kanonisasi untuk digest/replay. */
function requestDigest(request) {
    return canonicalJson({
        purpose: request.purpose,
        exec: { role: request.exec.role, capabilitySet: [...request.exec.capabilitySet] },
        tools: [],
        maxTokens: request.maxTokens
    });
}

function clamp01(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function structured(v) {
    return v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
}

module.exports = {
    normalizeDescriptor, makeCognitiveRequest,
    makeProposal, requestDigest
};
