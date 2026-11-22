"use strict";

const PREFIX = "selfmaint:";

function makeMaintenanceStore(acc) {
    async function getProposals() {
        return (await acc.getKv(`${PREFIX}proposals`)) || [];
    }
    async function putProposal(proposal) {
        const list = await getProposals();
        const idx = list.findIndex(p => p.proposalId === proposal.proposalId);
        if (idx >= 0) list[idx] = proposal; else list.push(proposal);
        await acc.putKv(`${PREFIX}proposals`, list);
    }
    async function getTransitions() {
        return (await acc.getKv(`${PREFIX}transitions`)) || [];
    }
    async function addTransition(transition) {
        const list = await getTransitions();
        list.push(transition);
        await acc.putKv(`${PREFIX}transitions`, list);
    }
    async function getLastDrill() {
        const drills = (await acc.getKv(`${PREFIX}drills`)) || [];
        if (drills.length === 0) return null;
        return drills[drills.length - 1];
    }
    async function putDrill(drill) {
        const drills = (await acc.getKv(`${PREFIX}drills`)) || [];
        drills.push(drill);
        await acc.putKv(`${PREFIX}drills`, drills);
    }
    async function getHeadroom() {
        return (await acc.getKv(`${PREFIX}headroom`)) || null;
    }
    async function putHeadroom(entry) {
        await acc.putKv(`${PREFIX}headroom`, entry);
    }
    return { getProposals, putProposal, getTransitions, addTransition, getLastDrill, putDrill, getHeadroom, putHeadroom };
}

module.exports = { makeMaintenanceStore };
