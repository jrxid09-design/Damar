/**
 * IdentityStore (I§4) — persistence port for device identity/pairing.
 *
 * Same contract as BodyStore: save() deep-copies input; load() returns a
 * fresh copy. V1 ships a deterministic MEMORY reference implementation.
 * A future SQLite adapter implements the same two methods against
 * serialize()/restore() — data shape is final, only backend changes.
 */

const { fail, structuredCopy } = require("../core/util");
const { DeviceIdentityService } = require("./service");
const { createFileIdentityStore } = require("./fileStore");

function createMemoryIdentityStore() {
    let saved = null;
    return {
        backend: "memory",
        async save(serialized) { saved = structuredCopy(serialized); return true; },
        async load() { return saved ? structuredCopy(saved) : null; }
    };
}

async function persistIdentity(svc, store) {
    if (!store) throw fail("PID_NO_STORE", "tidak ada store terpasang");
    return store.save(svc.serialize());
}

async function loadIdentity({ store, clock, config, entropy, body } = {}) {
    if (!store) throw fail("PID_NO_STORE", "store wajib untuk loadIdentity");
    const data = await store.load();
    if (!data) return null;
    return DeviceIdentityService.restore(data, { clock, config, entropy, body });
}

module.exports = { createMemoryIdentityStore, persistIdentity, loadIdentity, createFileIdentityStore };
