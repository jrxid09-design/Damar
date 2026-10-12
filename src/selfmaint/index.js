"use strict";

const { LAWS, BOUNDS, HEALTH_STATES, MODES, PROPOSAL_STATES } = require("./laws");
const { makeMaintenanceStore } = require("./store");
const { makeHealthOps } = require("./health");
const { makeModeOps } = require("./modes");
const { makeProposalOps } = require("./proposal");
const { makeDrillOps } = require("./drills");
const { makeHeadroomOps } = require("./headroom");

function makeSelfMaintenance(acc) {
    const store = makeMaintenanceStore(acc);
    const health = makeHealthOps();
    const modes = makeModeOps(store);
    const proposals = makeProposalOps(store);
    const drills = makeDrillOps(store, BOUNDS);
    const headroom = makeHeadroomOps(store);

    return {
        store,
        health,
        modes,
        proposals,
        drills,
        headroom,
        LAWS,
        BOUNDS,
        HEALTH_STATES,
        MODES,
        PROPOSAL_STATES,
    };
}

module.exports = { makeSelfMaintenance };
