"use strict";

const PREFIX = "agency:";

function makeAgencyStore(acc) {
    async function getIntentions() {
        return (await acc.getKv(`${PREFIX}intentions`)) || [];
    }
    async function putIntention(intention) {
        const list = await getIntentions();
        const idx = list.findIndex(i => i.intentionId === intention.intentionId);
        if (idx >= 0) list[idx] = intention; else list.push(intention);
        await acc.putKv(`${PREFIX}intentions`, list);
    }
    async function getDecisions() {
        return (await acc.getKv(`${PREFIX}decisions`)) || [];
    }
    async function putDecision(decision) {
        const list = await getDecisions();
        const idx = list.findIndex(d => d.decisionId === decision.decisionId);
        if (idx >= 0) list[idx] = decision; else list.push(decision);
        await acc.putKv(`${PREFIX}decisions`, list);
    }
    // RT-W10-42: pending/deliberating decisions must be abandoned on restart
    async function abandonPendingIntentions() {
        const decisions = await getDecisions();
        const active = decisions.filter(d => d.state === "PENDING" || d.state === "DELIBERATING");
        for (const d of active) {
            d.state = "ABANDONED";
            d.abandonedAt = Date.now();
            d.abandonReason = "restart";
        }
        if (active.length > 0) {
            await acc.putKv(`${PREFIX}decisions`, decisions);
        }
        return active.length;
    }
    return { getIntentions, putIntention, getDecisions, putDecision, abandonPendingIntentions };
}

module.exports = { makeAgencyStore };
