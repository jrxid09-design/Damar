"use strict";

const { BOUNDS } = require("./laws");

// Higher rank = stronger verification guarantee; compaction may never raise rank
const STATE_RANK = {
    SUPPORTED: 4,
    PARTIALLY_SUPPORTED: 3,
    UNSUPPORTED: 2,
    DISPUTED: 1,
    EVIDENCE_ARCHIVED: 0,
};

function assertCompactionDoesNotRaise(before, after) {
    // RT-W10-28: compaction never raises verificationState
    const beforeRank = STATE_RANK[before] !== undefined ? STATE_RANK[before] : 2;
    const afterRank = STATE_RANK[after] !== undefined ? STATE_RANK[after] : 2;
    if (afterRank > beforeRank) {
        throw new Error(`Compaction may not raise verificationState from ${before} to ${after} (W10-L3/RT-W10-28)`);
    }
    return true;
}

function applyRetention(episodes) {
    if (!Array.isArray(episodes) || episodes.length <= BOUNDS.MAX_EPISODES_RETAINED) return episodes;
    // Keep the most recent MAX_EPISODES_RETAINED episodes
    return episodes.slice(episodes.length - BOUNDS.MAX_EPISODES_RETAINED);
}

module.exports = { applyRetention, assertCompactionDoesNotRaise, STATE_RANK };
