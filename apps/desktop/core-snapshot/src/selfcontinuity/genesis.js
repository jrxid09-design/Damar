"use strict";

const { makeIdentityRecord } = require("./identity");

function makeGenesisOps(store) {
    async function createIdentity(opts) {
        const existing = await store.getIdentity();
        if (existing) {
            throw new Error("Genesis refused — identity already exists, single genesis enforced (W10-L2/RT-W10-20)");
        }
        const identity = makeIdentityRecord(opts);
        await store.putIdentity(identity);
        return identity;
    }
    return { createIdentity };
}

module.exports = { makeGenesisOps };
