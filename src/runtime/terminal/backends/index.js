const local = require("./LocalBackend");

/**
 * Registry backend eksekusi. Tambah Docker/SSH/Remote di masa depan
 * dengan register(backend) — TerminalRuntime memilih lewat target.
 */
const registry = new Map([[local.id, local]]);

module.exports = {
    local,
    get(id) { return registry.get(id) || local; },
    register(backend) { registry.set(backend.id, backend); return this; },
    list() { return [...registry.keys()]; }
};
