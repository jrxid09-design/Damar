"use strict";

/**
 * Sertifikasi MD-005 + MD-006 — skema spasial ketat & fusi berbasis lineage.
 *
 * MD-005: immutable mendalam (mutasi input TIDAK menembus rekaman),
 * geometri ketat, timestamp ketat (negatif/masa depan/skew), confidence
 * reject bukan clamp, string bounded, prototype/getter aman.
 *
 * MD-006: kemandirian dari lineage (bukan string sumber), cermin upstream
 * dihitung satu, anti-bridge clustering (A-B-C tidak dipaksa satu event),
 * bukti pergerakan PREDICTED tidak diklaim OBSERVED.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const observationModel = require("../../src/mataDewa/observations/observation");
const eventModel = require("../../src/mataDewa/events/event");
const fusion = require("../../src/mataDewa/events/fusion");
const lineageModel = require("../../src/mataDewa/spatial/lineage");
const { CanonError } = require("../../src/mataDewa/spatial/strictSchemas");

const NOW = 1_700_000_000_000;

function pointObs(overrides = {}) {
    return observationModel.normalizeObservation({
        source: "prov-a", type: "fire",
        location: { lat: -6.6, lon: 106.8 },
        observedAt: NOW - 1000, confidence: 0.7,
        ...overrides
    }, { nowMs: NOW }).observation;
}

// ---- MD-005: deep immutability -------------------------------------------

test("MD-005: mutasi input SETELAH konstruksi tidak mengubah observasi", () => {
    const attributes = { level: 3, nested: { deep: "v" } };
    const result = observationModel.normalizeObservation({
        source: "x", type: "flood", location: { lat: 0, lon: 0 },
        observedAt: NOW - 100, attributes
    }, { nowMs: NOW });
    assert.equal(result.ok, true);
    const obs = result.observation;
    // Mutasi input asli (bersarang).
    attributes.level = 999;
    attributes.nested.deep = "MUTATED";
    attributes.nested.injected = true;
    // Rekaman kanonik tetap.
    assert.equal(obs.attributes.level, 3);
    assert.equal(obs.attributes.nested.deep, "v");
    assert.equal("injected" in obs.attributes, false);
    // Dan rekaman itu sendiri beku total.
    assert.equal(Object.isFrozen(obs), true);
    assert.equal(Object.isFrozen(obs.attributes), true);
    assert.equal(Object.isFrozen(obs.attributes.nested), true);
    assert.throws(() => { "use strict"; obs.attributes.level = 5; }, TypeError);
});

test("MD-005: mutasi input SETELAH konstruksi tidak mengubah event (evidence bersarang)", () => {
    const evidence = [{ observationId: "o1", note: { secret: "orig" } }];
    const result = eventModel.createEvent({
        type: "fire", location: { lat: 0, lon: 0 },
        firstObservedAt: NOW - 100, evidence, sources: ["a"]
    }, { nowMs: NOW });
    assert.equal(result.ok, true);
    const evt = result.event;
    evidence[0].note.secret = "TAMPERED";
    evidence[0].note.hacked = true;
    evidence.push({ observationId: "injected" });
    assert.equal(evt.evidence[0].note.secret, "orig");
    assert.equal("hacked" in evt.evidence[0].note, false);
    assert.equal(evt.evidence.length, 1);
    assert.equal(Object.isFrozen(evt), true);
    assert.equal(Object.isFrozen(evt.evidence), true);
    assert.equal(Object.isFrozen(evt.evidence[0]), true);
});

test("MD-005: confidence reject bukan clamp — 4.7, -0.2, NaN, Infinity, string", () => {
    for (const bad of [4.7, -0.2, NaN, Infinity, "0.9"]) {
        const result = observationModel.normalizeObservation({
            source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 10, confidence: bad
        }, { nowMs: NOW });
        assert.equal(result.ok, false, `confidence ${bad} harus ditolak`);
        assert.match(String(result.reason), /confidence/);
    }
});

test("MD-005: timestamp ketat — negatif, NaN, masa depan melebihi skew ditolak", () => {
    assert.equal(observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: -5000
    }, { nowMs: NOW }).ok, false);
    assert.equal(observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NaN
    }, { nowMs: NOW }).ok, false);
    // Masa depan jauh → tolak.
    assert.equal(observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW + 60 * 60 * 1000
    }, { nowMs: NOW }).ok, false);
    // Skew kecil (30 detik) → diterima.
    const small = observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW + 30 * 1000
    }, { nowMs: NOW });
    assert.equal(small.ok, true);
    // Event: kronologi terbalik ditolak.
    assert.equal(eventModel.createEvent({
        location: { lat: 0, lon: 0 }, firstObservedAt: NOW,
        lastObservedAt: NOW - 1000
    }, { nowMs: NOW }).ok, false);
});

test("MD-005: geometri ketat — polygon tak tertutup, koordinat tak finite, tipe asing ditolak", () => {
    assert.equal(observationModel.normalizeObservation({
        source: "x", observedAt: NOW - 10,
        geometry: { type: "polygon", coordinates: [[0, 0], [1, 0], [1, 1]] }
    }, { nowMs: NOW }).ok, false);
    assert.equal(observationModel.normalizeObservation({
        source: "x", observedAt: NOW - 10,
        geometry: { type: "point", lat: NaN, lon: 0 }
    }, { nowMs: NOW }).ok, false);
    assert.equal(observationModel.normalizeObservation({
        source: "x", observedAt: NOW - 10,
        geometry: { type: "hexagon" }
    }, { nowMs: NOW }).ok, false);
    // LineString & polygon valid diterima.
    const line = observationModel.normalizeObservation({
        source: "x", observedAt: NOW - 10,
        geometry: { type: "linestring", coordinates: [[106, -6], [107, -5]] }
    }, { nowMs: NOW });
    assert.equal(line.ok, true);
    assert.equal(line.observation.geometry.coordinates.length, 2);
});

test("MD-005: string & struktur bounded — overflow ditolak (bukan dipotong diam-diam)", () => {
    assert.equal(observationModel.normalizeObservation({
        source: "S".repeat(300), location: { lat: 0, lon: 0 }, observedAt: NOW - 10
    }, { nowMs: NOW }).ok, false);
    assert.equal(observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 10,
        attribution: "A".repeat(1000)
    }, { nowMs: NOW }).ok, false);
    // atribut dalam > batas node.
    const wide = {};
    for (let i = 0; i < 600; i++) wide[`k${i}`] = i;
    assert.equal(observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 10, attributes: wide
    }, { nowMs: NOW }).ok, false);
});

test("MD-005: prototype hostil & getter tidak dieksekusi — ditolak", () => {
    class EvilAttributes { constructor() { this.v = 1; } }
    const withGetter = { source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 10 };
    withGetter.attributes = {};
    Object.defineProperty(withGetter.attributes, "boom", {
        get() { throw new Error("GETTER_EXECUTED"); }, enumerable: true
    });
    // Getter hostil → observasi DITOLAK dengan alasan getter
    // (fail-closed; getter tidak dieksekusi).
    const getterResult = observationModel.normalizeObservation(withGetter, { nowMs: NOW });
    assert.equal(getterResult.ok, false);
    assert.match(String(getterResult.reason), /getter/);
    const evil = observationModel.normalizeObservation({
        source: "x", location: { lat: 0, lon: 0 }, observedAt: NOW - 10,
        attributes: new EvilAttributes()
    }, { nowMs: NOW });
    assert.equal(evil.ok, false);
    void CanonError;
});

// ---- MD-006: lineage & fusi ------------------------------------------------

test("MD-006: lineage — cermin upstream yang sama dihitung SATU grup kemandirian", () => {
    const a = pointObs({ source: "usgs-primary", lineage: { providerId: "usgs-primary", providerFamily: "usgs", upstreamDataset: "anss-comcat", independenceGroup: "anss-comcat" } });
    const b = pointObs({ source: "usgs-mirror", lineage: { providerId: "usgs-mirror", providerFamily: "usgs", upstreamDataset: "anss-comcat", independenceGroup: "anss-comcat" } });
    const c = pointObs({ source: "gema-own", lineage: { providerId: "gema-own", providerFamily: "internal-sensor", independenceGroup: "gema-own" } });
    assert.equal(lineageModel.independentGroupCount([a, b]), 1, "cermin dihitung satu");
    assert.equal(lineageModel.independentGroupCount([a, c]), 2, "grup berbeda = independen");
    assert.equal(lineageModel.areIndependent(a, b), false);
    assert.equal(lineageModel.areIndependent(a, c), true);
});

test("MD-006: fallback lineage — tanpa deklarasi eksplisit, providerId/source dipakai (tidak ada bonus hantu)", () => {
    const a = pointObs({ source: "alpha" });
    const b = pointObs({ source: "beta" });
    // Tanpa lineage, dua string sumber = dua grup (perilaku fallback).
    assert.equal(lineageModel.independentGroupCount([a, b]), 2);
    // Tapi dengan lineage yang menyatakan upstream sama → SATU.
    const a2 = pointObs({ source: "alpha", lineage: { providerId: "alpha", independenceGroup: "same-upstream" } });
    const b2 = pointObs({ source: "beta", lineage: { providerId: "beta", independenceGroup: "same-upstream" } });
    assert.equal(lineageModel.independentGroupCount([a2, b2]), 1);
});

test("MD-006: confidence fusi — cermin ganda TIDAK menaikkan confidence", () => {
    const mirrorA = pointObs({ source: "src-a", lineage: { providerId: "src-a", independenceGroup: "upstream-X" } });
    const mirrorB = pointObs({ source: "src-b", lineage: { providerId: "src-b", independenceGroup: "upstream-X" } });
    const trulyB = pointObs({ source: "src-c", lineage: { providerId: "src-c", independenceGroup: "upstream-Y" } });

    const mirrored = fusion.fuseCluster([mirrorA, mirrorB], { nowMs: NOW });
    const independent = fusion.fuseCluster([mirrorA, trulyB], { nowMs: NOW });
    assert.equal(mirrored.ok && independent.ok, true);
    assert.ok(
        independent.event.confidence > mirrored.event.confidence,
        `independen (${independent.event.confidence}) harus > cermin (${mirrored.event.confidence})`);
    // Evidence membawa grup kemandirian untuk audit.
    assert.ok(independent.event.evidence.every(e => typeof e.independenceGroup === "string"));
    assert.equal(independent.event.lineage.kind, "derived");
});

test("MD-006 anti-bridge: A-B-C berantai TIDAK dipaksa satu event", () => {
    // maxDistanceM kecil: A dekat B, B dekat C, A TIDAK kompatibel C.
    const opts = { maxDistanceM: 3000, maxTimeGapMs: 60 * 1000 };
    const mk = (lat, lon, src) => pointObs({
        source: src, location: { lat, lon }, observedAt: NOW - 1000
    });
    const a = mk(-6.60, 106.80, "s1"); // A
    const b = mk(-6.62, 106.82, "s2"); // ~2.9 km dari A dan dari C
    const c = mk(-6.64, 106.84, "s3"); // C ~2.9 km dari B, ~5.8 km dari A

    // Sanity: jarak A-C harus di luar ambang.
    const { haversineMeters } = require("../../src/mataDewa/spatial/geo");
    assert.ok(haversineMeters(a.geometry, c.geometry) > 3000);

    const { events, unclustered } = fusion.fuseObservations([a, b, c], opts);
    // Tidak ada event yang mencakup ketiganya.
    for (const evt of events) {
        assert.notEqual(evt.sources.length, 3, "A-B-C tidak boleh jadi satu event");
    }
    // Kombinasi yang sah (pasangan dekat) boleh terbentuk; sisanya tak terklaster.
    const totalInEvents = events.reduce((s, e) => s + e.sources.length, 0);
    assert.equal(totalInEvents + unclustered.length, 3);
});

test("MD-006: observasi duplikat dari provider sama → event tunggal, bukan dua bukti independen", () => {
    const a1 = pointObs({ source: "src", id: "dup-1" });
    const a2 = pointObs({ source: "src", id: "dup-2" });
    const fused = fusion.fuseCluster([a1, a2], { nowMs: NOW });
    assert.equal(fused.ok, true);
    assert.equal(fused.event.sources.length, 1);
    // Confidence event tunggal-sumber tidak boleh lebih tinggi dari input.
    assert.ok(fused.event.confidence <= Math.max(a1.confidence, 0.99 * 0.85 + 0.0) + 1e-9);
});

test("MD-006: dua kebakaran berdekatan tapi independen tetap dua event bila saling tak kompatibel", () => {
    const opts = { maxDistanceM: 1000, maxTimeGapMs: 60 * 1000 };
    const fire1 = pointObs({ source: "s1", location: { lat: -6.60, lon: 106.80 }, observedAt: NOW - 1000 });
    const fire2 = pointObs({ source: "s2", location: { lat: -6.65, lon: 106.85 }, observedAt: NOW - 1000 });
    const { events } = fusion.fuseObservations([fire1, fire2], opts);
    assert.equal(events.length, 0, "di luar ambang → tidak digabung");
});

test("MD-006: pergerakan HANYA PREDICTED dengan bukti — lintasan tidak diklaim OBSERVED", () => {
    const t1 = pointObs({ source: "radar", location: { lat: -6.0, lon: 106.0 }, observedAt: NOW - 60000 });
    const t2 = pointObs({ source: "radar", location: { lat: -6.1, lon: 106.1 }, observedAt: NOW });
    const movement = fusion.estimateMovement([t1, t2]);
    assert.ok(movement);
    assert.equal(movement.epistemic, "PREDICTED");
    // Tanpa bukti pergerakan (tetap di tempat) → null.
    const still = fusion.estimateMovement([t1, pointObs({ source: "radar", location: { lat: -6.0, lon: 106.0 }, observedAt: NOW })]);
    assert.equal(still, null);
});
