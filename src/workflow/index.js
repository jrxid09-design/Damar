"use strict";

const { makeWorkflowStore } = require("./store");
const { makeWorkflow } = require("./workflow");

function makeWorkflowIntelligence(acc) {
    const store = makeWorkflowStore(acc);
    const workflow = makeWorkflow(store);
    return { workflow };
}

module.exports = { makeWorkflowIntelligence };
