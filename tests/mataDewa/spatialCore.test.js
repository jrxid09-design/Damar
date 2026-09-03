/**
 * Sertifikasi Lane 5 — MODEL SPASIAL: observasi, event, fusi, coverage,
 * timeline, epistemic status.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const observationModel = require("../../src/mataDewa/observations/observation");
const eventModel = require("../../src/mataDewa/events/event");
const fusion = require("../../src/mataDewa/events/fusion");
const coverage = require("../../src/mataDewa/coverage/coverage");
const epistemic = require("../../src/mataDewa/spatial/epistemic");
const geo = require("../../src/mataDewa/spatial/geo");
const { ProviderRegistry } = require("../../src/mataDewa/registry/providerRegistry");
const { SpatialTimeline } = require("../../src/mataDewa/timeline/timeline");

const NOW = 1759500000000;

test("OBSERVATION: schema validation — tanpa geometry ditolak", () => {
    const bad = observationModel.normalizeObservation({ source: "x", observedAt: NOW });
    assert.equal(bad.ok, false);
    const badTime = observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }
    });
    assert.equal(badTime.ok, false);
    assert.match(badTime.reason, /observedAt/);
});

test("OBSERVATION: koordinat di luar rentang ditolak", () => {
    const bad = observationModel.normalizeObservation({
        source: "x", location: { lat: 95, lon: 200 }, observedAt: NOW
    });
    assert.equal(bad.ok, false);
});

test("OBSERVATION: normalisasi lengkap — confidence reject (bukan clamp) + akses + frozen", () => {
    // MD-005: confidence di luar [0,1] DITOLAK — tidak pernah di-clamp.
    const rejected = observationModel.normalizeObservation({
        source: "usgs", type: "earthquake",
        location: { lat: -6.6, lon: 106.8 },
        observedAt: NOW - 5000, confidence: 7,
        attributes: { mag: 4.2 },
        attribution: "USGS"
    }, { nowMs: NOW });
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.reason ?? ""), /di luar rentang/);

    const result = observationModel.normalizeObservation({
        source: "usgs", type: "earthquake",
        location: { lat: -6.6, lon: 106.8 },
        observedAt: NOW - 5000, confidence: 0.84,
        attributes: { mag: 4.2 },
        attribution: "USGS"
    }, { nowMs: NOW });
    assert.equal(result.ok, true);
    const obs = result.observation;
    assert.equal(obs.confidence, 0.84);
    assert.equal(obs.accessClass, "PUBLIC");
    assert.equal(obs.receivedAt, NOW);
    assert.equal(Object.isFrozen(obs), true);
    assert.equal(obs.id.startsWith("obs_"), true);
});

test("OBSERVATION: freshness — observasi basi tidak boleh dianggap live", () => {
    const fresh = observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 1000
    }, { nowMs: NOW });
    const stale = observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 3 * 60 * 60 * 1000
    }, { nowMs: NOW });
    assert.equal(epistemic.isLive(fresh.observation.observedAt, {}, NOW), true);
    assert.equal(epistemic.isLive(stale.observation.observedAt, {}, NOW), false);
    const described = observationModel.describeFreshness(stale.observation, {}, NOW);
    assert.equal(described.band, "stale");
});

test("EVENT: severity order + fusi tidak menggabungkan yang tak kompatibel", () => {
    assert.equal(eventModel.severityAtLeast("warning", "watch"), true);
    assert.equal(eventModel.severityAtLeast("info", "critical"), false);
    assert.equal(eventModel.canonicalSeverity("nonsense"), "info");
});

test("FUSION: observasi kompatibel (tipe+waktu+jarak) terfusi dengan evidence lineage", () => {
    const a = observationModel.normalizeObservation({
        source: "usgs", type: "earthquake", location: { lat: -6.6, lon: 106.8 },
        observedAt: NOW - 1000, confidence: 0.9
    }, { nowMs: NOW }).observation;
    const b = observationModel.normalizeObservation({
        source: "bmkg", type: "earthquake", location: { lat: -6.61, lon: 106.81 },
        observedAt: NOW - 2000, confidence: 0.85
    }, { nowMs: NOW }).observation;
    const c = observationModel.normalizeObservation({
        source: "other", type: "flight", location: { lat: -6.605, lon: 106.805 },
        observedAt: NOW - 1500
    }, { nowMs: NOW }).observation; // dekat tapi tipe beda → TIDAK boleh terfusi

    const { events, unclustered } = fusion.fuseObservations([a, b, c], {
        maxDistanceM: 30000, maxTimeGapMs: 60 * 60 * 1000
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "earthquake");
    assert.equal(events[0].epistemic, "INFERRED");
    // Independensi sumber menaikkan confidence; evidence lineage dipertahankan.
    assert.equal(events[0].sources.length, 2);
    assert.equal(events[0].evidence.length, 2);
    assert.equal(events[0].evidence[0].observationId != null, true);
    assert.deepEqual(unclustered.map(o => o.id), [c.id]);
});

test("FUSION: observasi dekat TAPI jauh waktunya TIDAK terfusi", () => {
    const a = observationModel.normalizeObservation({
        source: "x", type: "fire", location: { lat: 0, lon: 0 }, observedAt: NOW - 5 * 60 * 60 * 1000
    }, { nowMs: NOW }).observation;
    const b = observationModel.normalizeObservation({
        source: "x", type: "fire", location: { lat: 0.001, lon: 0 }, observedAt: NOW
    }, { nowMs: NOW }).observation;
    const { events } = fusion.fuseObservations([a, b], { maxTimeGapMs: 60 * 60 * 1000 });
    assert.equal(events.length, 0);
});

test("FUSION: pergerakan hanya bila ada bukti — PREDICTED berbeda dari OBSERVED", () => {
    const still = [
        observationModel.normalizeObservation({ source: "x", type: "storm", location: { lat: 0, lon: 0 }, observedAt: NOW - 60000 }, { nowMs: NOW }).observation,
        observationModel.normalizeObservation({ source: "x", type: "storm", location: { lat: 0, lon: 0 }, observedAt: NOW }, { nowMs: NOW }).observation
    ];
    assert.equal(fusion.estimateMovement(still), null); // tanpa perpindahan → tanpa klaim

    const moving = [
        observationModel.normalizeObservation({ source: "x", type: "storm", location: { lat: 0, lon: 0 }, observedAt: NOW - 600000 }, { nowMs: NOW }).observation,
        observationModel.normalizeObservation({ source: "x", type: "storm", location: { lat: 0.05, lon: 0.05 }, observedAt: NOW }, { nowMs: NOW }).observation
    ];
    const movement = fusion.estimateMovement(moving);
    assert.equal(movement.epistemic, "PREDICTED");
    assert.ok(movement.speedMps > 0);
});

test("COVERAGE: 'tidak ada observasi' dibedakan jujur — observing vs blind", async () => {
    const registry = new ProviderRegistry({ clock: { nowMs: () => NOW } });
    registry.registerProvider({
        id: "regional-only", label: "x", types: ["fire"],
        accessMode: "PUBLIC_NO_KEY",
        coverage: { kind: "regional", center: { lat: 0, lon: 0 }, radiusM: 100000 },
        poll: async () => []
    });
    // Poll dulu agar status ketersediaan jujur (sebelum poll = not_polled_yet).
    await registry.pollProvider("regional-only", {});
    const inside = coverage.interpretAbsence(registry, { type: "fire", point: { lat: 0.1, lon: 0.1 } });
    assert.equal(inside.status, "observing"); // tercakup & tersedia → ketiadaan bermakna
    const outside = coverage.interpretAbsence(registry, { type: "fire", point: { lat: 40, lon: 40 } });
    assert.equal(outside.status, "blind"); // di luar coverage → ketiadaan BUKAN bukti
    assert.equal(outside.assess.reason, "outside_coverage");
});

test("COVERAGE: provider butuh kredensial tanpa resolver → blocked, bukan bypass", async () => {
    const registry = new ProviderRegistry({ clock: { nowMs: () => NOW } });
    registry.registerProvider({
        id: "keyed", label: "x", types: ["traffic"],
        accessMode: "API_KEY", accessClass: "RESTRICTED",
        poll: async () => { throw new Error("should not be called"); }
    });
    // Poll tanpa resolver → ditolak tertutup, BUKAN dipanggil.
    const poll = await registry.pollProvider("keyed", {});
    assert.equal(poll.ok, false);
    assert.equal(poll.failureReason, "credentials_absent");
    const assess = coverage.assessCoverage(registry, { type: "traffic", point: { lat: 0, lon: 0 } });
    assert.equal(assess.observable, false);
    assert.equal(assess.providers[0].blocked, true);
    assert.equal(assess.providers[0].reason, "credentials_absent");
});

test("TIMELINE: bounded + menjawab 'apa yang berubah di sini'", () => {
    const timeline = new SpatialTimeline({ maxEntries: 5, clock: { nowMs: () => NOW } });
    for (let i = 0; i < 20; i++) {
        timeline.record({
            id: `obs_${i}`, type: "earthquake",
            geometry: { type: "point", lat: -6.6, lon: 106.8 },
            observedAt: NOW - i * 1000
        }, { kind: "observation" });
    }
    assert.equal(timeline.size, 5); // bounded
    const hits = timeline.near({ lat: -6.6, lon: 106.8 }, 50000);
    assert.equal(hits.length, 5);
    assert.ok(hits[0].atMs >= hits[hits.length - 1].atMs); // terbaru dulu
    assert.equal(timeline.seenBefore({ lat: -6.6, lon: 106.8 }, 50000, "earthquake", NOW - 2000), true);
});

test("GEO: haversine & bounding box akurat untuk pra-filter", () => {
    // Bogor → Jakarta ~ 49 km
    const d = geo.haversineMeters({ lat: -6.595, lon: 106.816 }, { lat: -6.2, lon: 106.816 });
    assert.ok(d > 40000 && d < 48000, `jarak tak wajar: ${d}`);
    const box = geo.boundingBox({ lat: -6.6, lon: 106.8 }, 25000);
    assert.ok(geo.inBoundingBox({ lat: -6.6, lon: 106.8 }, box));
    assert.ok(!geo.inBoundingBox({ lat: -6.9, lon: 107.3 }, box));
});
