"use strict";

const { makePreference } = require("./preference");
const { BOUNDS, PREFERENCE_ORIGINS } = require("./laws");

function makePreferenceLearning(store) {
    async function learnPreference(opts) {
        // RT-W10-31: rate limit for inferred preferences — max 5 per day
        if (opts.origin === PREFERENCE_ORIGINS.INFERRED) {
            const todayInferred = await store.getInferredTodayCount();
            if (todayInferred >= BOUNDS.MAX_INFERRED_PER_DAY) {
                return { queued: true, reason: "rate_cap_inferred", preferenceId: opts.preferenceId };
            }
        }
        const pref = makePreference(opts);
        await store.putPreference(pref);
        if (opts.origin === PREFERENCE_ORIGINS.INFERRED) {
            await store.incrementInferredToday();
        }
        return pref;
    }
    return { learnPreference };
}

module.exports = { makePreferenceLearning };
