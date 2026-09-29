"use strict";

const { makeMissionIntelligence } = require("../mission");
const { makeStrategy } = require("../strategy");
const { makeAgentFed } = require("../../agentfed");
const { makeCollab } = require("../../collab");
const { makeResourcePlan } = require("../../resourceplan");
const { makeWorkflowIntelligence } = require("../../workflow");

function makeOpenWorldOps(acc) {
    const mission = makeMissionIntelligence(acc);
    const agentFed = makeAgentFed(acc);
    const collab = makeCollab(acc);
    const workflow = makeWorkflowIntelligence(acc);
    const resourcePlan = makeResourcePlan(acc);
    const strategy = makeStrategy(acc);
    return { mission, agentFed, collab, workflow, resourcePlan, strategy };
}

module.exports = { makeOpenWorldOps };
