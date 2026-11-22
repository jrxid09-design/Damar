"use strict";

const { BOUNDS } = require("./bounds");
const { LAWS } = require("./laws");
const { makeWorkspaceStore } = require("./store");
const { makeAdmission } = require("./admission");
const { makeEviction } = require("./eviction");
const { makeAssembly } = require("./assembly");
const { makeWorkspace } = require("./workspace");

function makeWorkspaceIntelligence(acc) {
    const store = makeWorkspaceStore(acc);
    const admission = makeAdmission(store, BOUNDS, LAWS);
    const eviction = makeEviction(store);
    const assembly = makeAssembly(BOUNDS);
    const workspace = makeWorkspace(store, admission, eviction, assembly, BOUNDS, LAWS);
    return { workspace };
}

module.exports = { makeWorkspaceIntelligence };
