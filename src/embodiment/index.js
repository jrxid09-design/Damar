/**
 * Embodiment V0 — pintu publik tunggal (B§0).
 *
 * Sensorium → BodySchema → (kelak: Cognition → Authority → Actuation).
 * V0 membangun DUA lapis pertama saja:
 *
 *   const emb = require(".../embodiment");
 *   const body = emb.createBodySchema({ clock });
 *   body.registerProducer("fake.discovery");
 *   body.ingest(emb.makeEvent({...}));
 *   emb.getEmbodimentSummary(body);
 *
 * BATAS ISOLASI MILESTONE:
 *   - TIDAK menulis AetherSelf / ACC / Presence / Voice.
 *   - TIDAK ada jalur aktuasi produksi — kanal aktuator hanya
 *     DIDESKRIPSI, tidak pernah DIEKSEKUSI.
 *   - TIDAK me-require src/cognition maupun src/database.
 */

const { BodySchema } = require("./schema/BodySchema");
const { getEmbodimentSummary } = require("./schema/EmbodimentSummary");
const {
    makeEvent, validateEventShape, EVENT_TYPES,
    PROVENANCES, CORE_SOURCE, SCHEMA_VERSION
} = require("./sensorium/events");
const { runDiscoveryCycle, validateAdapter } = require("./discovery/adapter");
const { createFakeDiscoveryAdapter } = require("./discovery/FakeDiscoveryAdapter");
const { createHostSelfDiscoveryAdapter }
    = require("./discovery/HostDiscoveryAdapter");
const { createMemoryBodyStore, loadBodySchema }
    = require("./persistence/BodyStore");

const domainTypes = require("./domain/types");
const identity = require("./core/identity");
const descriptor = require("./domain/descriptor");
const { realClock, manualClock } = require("./core/util");

/** Skema tubuh baru siap pakai. */
function createBodySchema(options = {}) {
    return new BodySchema(options);
}

module.exports = {
    // inti
    createBodySchema, BodySchema,
    getEmbodimentSummary,

    // sensorium
    makeEvent, validateEventShape, EVENT_TYPES, PROVENANCES,
    CORE_SOURCE, SCHEMA_VERSION,

    // discovery
    runDiscoveryCycle, validateAdapter,
    createFakeDiscoveryAdapter, createHostSelfDiscoveryAdapter,

    // persistensi
    createMemoryBodyStore, loadBodySchema,

    // kontrak murni (untuk adapter & pengujian masa depan)
    types: domainTypes,
    identity, descriptor,
    realClock, manualClock
};
