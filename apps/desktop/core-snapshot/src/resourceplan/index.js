"use strict";

const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { LAWS } = require("./laws");
const { makeResourcePlanStore } = require("./store");
const { makeKinds } = require("./kinds");
const { makePlan } = require("./plan");
const { makeMeters } = require("./meters");
const { makeSlice } = require("./slice");
const { makeShortfall } = require("./shortfall");

function makeResourcePlan(acc) {
    const store = makeResourcePlanStore(acc);
    const kinds = makeKinds(store);
    const plan = makePlan(store, kinds);
    const meters = makeMeters(store);
    const slice = makeSlice(store, kinds);
    const shortfall = makeShortfall(store);
    return { kinds, plan, meters, slice, shortfall };
}

module.exports = { makeResourcePlan, BOUNDS, LAWS, SCHEMA_VERSION };
