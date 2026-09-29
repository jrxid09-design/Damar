"use strict";

const { LAWS, BOUNDS } = require("./laws");
const { makeSelfContinuityStore } = require("./store");
const { makeGenesisOps } = require("./genesis");
const { makeChainOps } = require("./chain");
const { makeCheckpoint, verifyCheckpoint } = require("./checkpoint");
const { makeIncarnationOps } = require("./incarnation");
const { makeForkOps } = require("./fork");
const { makeMigrationOps } = require("./migration");
const { CONTINUITY_LEVELS } = require("./levels");

function makeSelfContinuity(acc) {
    const store = makeSelfContinuityStore(acc);
    const genesis = makeGenesisOps(store);
    const chain = makeChainOps(store);
    const incarnation = makeIncarnationOps(store, BOUNDS);
    const fork = makeForkOps(store);
    const migration = makeMigrationOps();
    return {
        store,
        genesis,
        chain,
        checkpoint: { makeCheckpoint, verifyCheckpoint },
        incarnation,
        fork,
        migration,
        LAWS,
        BOUNDS,
        CONTINUITY_LEVELS,
    };
}

module.exports = { makeSelfContinuity };
