/** Harness bersama untuk tests/authority (jam suntik + store memori). */

const canonical = require("../../src/authority/canonical");
const model = require("../../src/authority/model");
const delegation = require("../../src/authority/delegation");
const registryMod = require("../../src/authority/registry");
const storeMod = require("../../src/authority/store");

const T0 = 1_760_000_000_000;      // 2025-10-08T21:33:20Z

function manualClock(startMs = T0) {
    let t = startMs;
    return {
        nowMs: () => t,
        nowIso: () => new Date(t).toISOString(),
        advance(ms) { t += ms; return t; },
        get value() { return t; }
    };
}

function makeRegistry({ store = null, startMs = T0 } = {}) {
    const clock = manualClock(startMs);
    const st = store ?? storeMod.createMemoryAuthorityStore();
    const registry = new registryMod.AuthorityRegistry({
        store: st, clock
    });
    return { registry, store: st, clock };
}

module.exports = {
    ...canonical, ...model, model, delegation,
    AuthorityRegistry: registryMod.AuthorityRegistry,
    createMemoryAuthorityStore: storeMod.createMemoryAuthorityStore,
    createSqliteAuthorityStore: storeMod.createSqliteAuthorityStore,
    createMemoryAccStore: storeMod.createMemoryAuthorityStore,
    manualClock, makeRegistry, T0
};
