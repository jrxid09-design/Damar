"use strict";

const { EPISODE_SCHEMA_VERSION, BOUNDS, VERIFICATION_STATES } = require("./laws");

function validateEpisode(opts) {
    if (!opts.episodeId) throw new Error("episodeId required");
    if (!opts.damarIdentityId) throw new Error("damarIdentityId required — episodes are identity-bound (W10-L3/RT-W10-30)");
    // RT-W10-23: an episode may never cite itself as evidence
    if (opts.evidence && opts.evidence.includes(opts.episodeId)) {
        throw new Error(`Episode may not cite itself as evidence (W10-L3/RT-W10-23)`);
    }
    return true;
}

function makeEpisode(opts = {}) {
    validateEpisode(opts);
    let narrative = opts.narrative || "";
    let narrativeTruncated = false;
    if (narrative.length > BOUNDS.MAX_NARRATIVE_CHARS) {
        narrative = narrative.slice(0, BOUNDS.MAX_NARRATIVE_CHARS);
        narrativeTruncated = true;
    }
    const rawEvidence = opts.evidence || [];
    const evidence = rawEvidence.slice(0, BOUNDS.MAX_EVIDENCE_REFS_PER_EPISODE);
    return {
        schemaVersion: EPISODE_SCHEMA_VERSION,
        episodeId: opts.episodeId,
        damarIdentityId: opts.damarIdentityId,
        title: opts.title || "",
        narrative,
        narrativeTruncated,
        window: opts.window || null,
        evidence,
        evidenceTruncated: rawEvidence.length > BOUNDS.MAX_EVIDENCE_REFS_PER_EPISODE,
        verificationState: VERIFICATION_STATES.UNSUPPORTED, // computed later via verification.js
        corrections: [],
        redacted: false,
        secretsRedacted: opts.secretsRedacted || false,
        createdAt: opts.createdAt || Date.now(),
    };
}

module.exports = { validateEpisode, makeEpisode };
