"use strict";

const { makeMissionStore } = require("./store");
const { makeMission } = require("./mission");
const { makeDelegation } = require("./delegation");
const { makeReport } = require("./report");

function makeMissionIntelligence(acc) {
    const store = makeMissionStore(acc);
    const mission = makeMission(store);
    const delegation = makeDelegation(store);
    const report = makeReport(store);
    return { mission, delegation, report };
}

module.exports = { makeMissionIntelligence };
