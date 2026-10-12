"use strict";

const PREFIX = "workspace:";

function makeWorkspaceStore(acc) {
    async function getItems() {
        return (await acc.getKv(`${PREFIX}items`)) || [];
    }
    async function putItems(items) {
        await acc.putKv(`${PREFIX}items`, items);
    }
    async function getEvictions() {
        return (await acc.getKv(`${PREFIX}evictions`)) || [];
    }
    async function addEviction(record) {
        const evictions = await getEvictions();
        evictions.push(record);
        await acc.putKv(`${PREFIX}evictions`, evictions);
    }
    async function getFocus() {
        return acc.getKv(`${PREFIX}focus`);
    }
    async function setFocus(itemId) {
        await acc.putKv(`${PREFIX}focus`, itemId);
    }
    return { getItems, putItems, getEvictions, addEviction, getFocus, setFocus };
}

module.exports = { makeWorkspaceStore };
