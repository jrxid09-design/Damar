"use strict";

function makeCorrection(store) {
    async function applyCorrection(episodeId, correctionData) {
        const episode = await store.getEpisodeById(episodeId);
        if (!episode) throw new Error(`Episode '${episodeId}' not found`);
        // RT-W10-22: corrections are additive — original narrative stays intact
        episode.corrections = episode.corrections || [];
        episode.corrections.push({
            at: Date.now(),
            correctionRef: correctionData.correctionRef || null,
            reason: correctionData.reason || "",
            byKind: correctionData.byKind || "OWNER",
        });
        await store.putEpisode(episode);
        return episode;
    }

    async function redactEpisode(episodeId, requestRecord) {
        // RT-W10-29: content redacted, but marker + request record must stay
        const episode = await store.getEpisodeById(episodeId);
        if (!episode) throw new Error(`Episode '${episodeId}' not found`);
        episode.narrative = "[REDACTED]";
        episode.redacted = true;
        episode.redactionAt = Date.now();
        episode.redactionRequest = requestRecord || null; // must be retained
        await store.putEpisode(episode);
        return episode;
    }

    return { applyCorrection, redactEpisode };
}

module.exports = { makeCorrection };
