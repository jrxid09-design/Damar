"use strict";

const { makeEpisode } = require("./episode");
const { computeVerificationState } = require("./verification");
const { BOUNDS } = require("./laws");

const SECRET_PATTERN = /\b(password|secret|token|credential|api_key|apikey|private_key)\b/gi;

function redactSecrets(narrative) {
    // RT-W10-26: redact secrets on formation
    if (!SECRET_PATTERN.test(narrative)) {
        SECRET_PATTERN.lastIndex = 0;
        return { narrative, secretsRedacted: false };
    }
    SECRET_PATTERN.lastIndex = 0;
    return { narrative: narrative.replace(SECRET_PATTERN, "[REDACTED]"), secretsRedacted: true };
}

function makeFormation(store) {
    async function formEpisode(opts, resolveEvidence) {
        // RT-W10-25: rate cap — coalesce when over limit
        const recent = await store.getRecentEpisodesInHour();
        if (recent.length >= BOUNDS.MAX_EPISODES_PER_HOUR) {
            return { coalesced: true, reason: "rate_cap", episodeId: opts.episodeId };
        }
        const { narrative, secretsRedacted } = redactSecrets(opts.narrative || "");
        const episode = makeEpisode({ ...opts, narrative, secretsRedacted });
        if (resolveEvidence) {
            episode.verificationState = computeVerificationState(episode, resolveEvidence);
        }
        await store.putEpisode(episode);
        return episode;
    }
    return { formEpisode };
}

module.exports = { makeFormation, redactSecrets };
