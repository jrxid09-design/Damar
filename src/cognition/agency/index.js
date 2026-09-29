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
    // RT-W10-42: abandon any in-flight decisions from a previous run on startup
    const initPromise = store.abandonPendingIntentions();
    const decideOps = makeDecide(store);

    function createBudget() {
        return makeDeliberationBudget(BOUNDS);
    }

    async function deliberate(intentionOpts, rawOptions, preferences, values) {
        await initPromise;
        const intention = makeIntention(intentionOpts);
        const coherent = filterOptions(rawOptions);
        const ranked = rankOptions(coherent, preferences || [], values || []);
        const budget = createBudget();
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
