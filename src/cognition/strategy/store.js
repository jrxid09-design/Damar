"use strict";

const P = "strategy:";

function makeStrategyStore(acc) {
    async function getKv(key) { return acc.getKv(`${P}${key}`); }
    async function putKv(key, value) { return acc.putKv(`${P}${key}`, value); }
    async function getIndex(name) { return (await acc.getKv(`${P}idx:${name}`)) || []; }
    async function addToIndex(name, id) {
        const idx = await getIndex(name);
        if (!idx.includes(id)) { idx.push(id); await acc.putKv(`${P}idx:${name}`, idx); }
    }
    return { getKv, putKv, getIndex, addToIndex };
}

module.exports = { makeStrategyStore };
