"use strict";

const PREFIX = "selfcontinuity:";

function makeSelfContinuityStore(acc) {
    async function getIdentity() {
        return acc.getKv(`${PREFIX}identity`);
    }
    async function putIdentity(identity) {
        await acc.putKv(`${PREFIX}identity`, identity);
    }
    async function getChain() {
        return (await acc.getKv(`${PREFIX}chain`)) || [];
    }
    async function addChainEntry(entry) {
        const chain = await getChain();
        chain.push(entry);
        await acc.putKv(`${PREFIX}chain`, chain);
    }
    async function getIncarnations() {
        return (await acc.getKv(`${PREFIX}incarnations`)) || [];
    }
    async function addIncarnation(incarnation) {
        const list = await getIncarnations();
        list.push(incarnation);
        await acc.putKv(`${PREFIX}incarnations`, list);
    }
    async function getForks() {
        return (await acc.getKv(`${PREFIX}forks`)) || [];
    }
    async function addFork(fork) {
        const forks = await getForks();
        forks.push(fork);
        await acc.putKv(`${PREFIX}forks`, forks);
    }
    return { getIdentity, putIdentity, getChain, addChainEntry, getIncarnations, addIncarnation, getForks, addFork };
}

module.exports = { makeSelfContinuityStore };
