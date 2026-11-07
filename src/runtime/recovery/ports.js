"use strict";

/**
 * Future integration ports (R27) — INERT.
 *
 * These are named attachment points only. No imports from candidate
 * branches, no production wiring, no behavior. A subsystem may later
 * implement the RecoveryProvider contract and register explicitly.
 */
const RECOVERY_INTEGRATION_PORTS = Object.freeze([
    "acc",
    "authority",
    "sensorium",
    "semantic-desktop",
    "resource-governor",
    "presence-runtime",
    "interaction-bus",
    "actuation-fabric"
].reduce((m, p) => ((m[p] = p), m), {}));

function createInertPort(name) {
    if (!Object.prototype.hasOwnProperty.call(RECOVERY_INTEGRATION_PORTS, name)) {
        throw new RangeError(`unknown recovery integration port: ${name}`);
    }
    return Object.freeze({
        port: name,
        wired: false,
        attach(provider) {
            if (!provider || provider.id !== name) {
                throw new RangeError(`port ${name}: provider id must match port name`);
            }
            return Object.freeze({ port: name, attached: true, providerId: provider.id });
        }
    });
}

module.exports = Object.freeze({
    RECOVERY_INTEGRATION_PORTS,
    createInertPort
});
