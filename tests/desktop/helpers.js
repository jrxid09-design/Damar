const {
    DesktopContextCore,
    ContextReferenceResolver
} = require("../../src/desktop");
const { FakeDesktopAdapter } = require("../../src/desktop/adapters/FakeDesktopAdapter");

/**
 * Helper bersama untuk suite semantic desktop: core + adapter fake
 * dengan kapabilitas lengkap, jam ter-inject, dan resolusi cepat.
 */

function makeHarness({ clockValue = 1000, limits = {}, startAdapter = true } = {}) {
    const clock = () => clockValue;
    const core = new DesktopContextCore({ clock, ...limits });
    const adapter = new FakeDesktopAdapter({
        emit: (o) => core.ingest(o),
        clock,
        instanceNonce: "test-nonce"
    });
    core.registerAdapter({
        adapterId: adapter.adapterId,
        trusted: true,
        capabilities: [...adapter.capabilities]
    });
    if (startAdapter) adapter.start();

    const resolve = (request) =>
        ContextReferenceResolver.resolve(core.getView(), request);

    return { core, adapter, clock, resolve };
}

/** Observasi mentah ringkas untuk pengujian tingkat rendah. */
function rawObservation({
    type,
    subject = null,
    timestamp = 1000,
    observationId,
    adapterId = "fake-desktop",
    entities = [],
    relationships = [],
    payload = {}
}) {
    return {
        type,
        observationId,
        timestamp,
        source: { adapterId },
        subject,
        entities,
        relationships,
        payload
    };
}

const E = (id, type, label = "", attributes = {}) => ({ id, type, label, attributes });

module.exports = { makeHarness, rawObservation, E };
