"use strict";

const { LAWS, BOUNDS, DECISION_STATES } = require("./laws");
const { makeAgencyStore } = require("./store");
const { makeIntention, validateIntention } = require("./intention");
const { filterOptions } = require("./options");
const { rankOptions } = require("./rank");
const { makeDeliberationBudget, BudgetExhaustedError } = require("./budget");
const { makeDecide } = require("./decide");

function makeUnifiedAgency(acc) {
    const store = makeAgencyStore(acc);
    // RT-W10-42: abandon in-flight decisions from previous run on startup
    let initDone = false;
    const initPromise = store.abandonPendingIntentions()
        .then(() => { initDone = true; })
        .catch(() => {}); // prevent unhandled rejection; initDone stays false on failure
    const decideOps = makeDecide(store);

    function createBudget() {
        return makeDeliberationBudget(BOUNDS);
    }

    async function deliberate(intentionOpts, rawOptions, preferences, values) {
        // Await original promise (never throws — catch above); then check if it succeeded.
        // If not, retry abandon: satisfies INTERRUPTED_INTENTIONS_ABANDONED on the failure path,
        // and throws if the store is still unavailable (P1+P2-1 fix).
        await initPromise;
        if (!initDone) {
            await store.abandonPendingIntentions();
            initDone = true;
        }
        const intention = makeIntention(intentionOpts);
        const budget = createBudget();
        budget.tick(); // intention formed
        const coherent = filterOptions(rawOptions);
        budget.tick(); // options filtered
        const ranked = rankOptions(coherent, preferences || [], values || []);
        return decideOps.decide(intention, ranked, preferences || [], values || [], budget);
    }

    return {
        store,
        makeIntention,
        validateIntention,
        filterOptions,
        rankOptions,
        createBudget,
        deliberate,
        LAWS,
        BOUNDS,
        DECISION_STATES,
        BudgetExhaustedError,
    };
}

module.exports = { makeUnifiedAgency };
