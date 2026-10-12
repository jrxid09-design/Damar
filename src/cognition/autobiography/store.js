"use strict";

const PREFIX = "autobiography:";

function makeAutobiographyStore(acc) {
    async function getEpisodes() {
        return (await acc.getKv(`${PREFIX}episodes`)) || [];
    }
    async function putEpisode(episode) {
        const episodes = await getEpisodes();
        const idx = episodes.findIndex(e => e.episodeId === episode.episodeId);
        if (idx >= 0) {
            episodes[idx] = episode;
        } else {
            episodes.push(episode);
        }
        await acc.putKv(`${PREFIX}episodes`, episodes);
    }
    async function getEpisodeById(episodeId) {
        const episodes = await getEpisodes();
        return episodes.find(e => e.episodeId === episodeId) || null;
    }
    async function getRecentEpisodesInHour() {
        const cutoff = Date.now() - 60 * 60 * 1000;
        const episodes = await getEpisodes();
        return episodes.filter(e => e.createdAt >= cutoff);
    }
    return { getEpisodes, putEpisode, getEpisodeById, getRecentEpisodesInHour };
}

module.exports = { makeAutobiographyStore };
