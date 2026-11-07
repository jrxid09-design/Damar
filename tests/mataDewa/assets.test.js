/**
 * Sertifikasi Lane 5 — ASSET & TOWER WATCH: impor, index, kebijakan,
 * lightning, performa (bukan O(N) per event).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AssetRegistry, ASSET_TYPE, normalizeAsset, canonicalWatchPolicy } = require("../../src/mataDewa/assets/assetRegistry");
const { importAssets, parseKml, parseGeoJson, parseCsv } = require("../../src/mataDewa/assets/importers");
const { evaluateLightningRisk, HAZARD_TYPE } = require("../../src/mataDewa/watch/lightning");
const { GridIndex } = require("../../src/mataDewa/spatial/gridIndex");

const NOW = 1759500000000;
const FIXTURE = path.join(__dirname, "fixtures", "synthetic-towers.csv");

test("ASSETS: impor CSV sintetis — id/tipe/metadata ternormalisasi", () => {
    const registry = new AssetRegistry();
    const csv = fs.readFileSync(FIXTURE, "utf8");
    const result = importAssets(registry, { format: "csv", data: csv, source: "synthetic" });
    assert.equal(result.imported.length, 5);
    assert.equal(result.rejected.length, 0);
    assert.equal(registry.size, 5);
    const tower = registry.get("SYN-T-001");
    assert.equal(tower.type, ASSET_TYPE.TOWER);
    assert.equal(tower.metadata.name, "Tower Alpha (synthetic)");
    assert.equal(tower.source, "synthetic");
});

test("ASSETS: id duplikat ditolak saat impor", () => {
    const registry = new AssetRegistry();
    const csv = fs.readFileSync(FIXTURE, "utf8");
    importAssets(registry, { format: "csv", data: csv });
    const dup = importAssets(registry, { format: "csv", data: csv });
    assert.equal(dup.duplicates, 5);
    assert.equal(registry.size, 5); // tidak bertambah
});

test("ASSETS: koordinat tidak valid ditolak dengan alasan", () => {
    const registry = new AssetRegistry();
    const csv = "id,lat,lon\nBAD-1,999,999\n";
    const result = importAssets(registry, { format: "csv", data: csv });
    assert.equal(result.imported.length, 0);
    assert.match(result.rejected[0].reason, /koordinat/);
});

test("ASSETS: GeoJSON + KML parse (fixture sintetis)", () => {
    const gj = JSON.stringify({
        type: "FeatureCollection",
        features: [{
            type: "Feature",
            geometry: { type: "Point", coordinates: [106.8, -6.6] },
            properties: { id: "GJ-1", type: "tower", name: "Synthetic GJ" }
        }]
    });
    const parsed = parseGeoJson(gj);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].location.lat, -6.6);

    const kml = `<?xml version="1.0"?><kml><Document>
        <Placemark><name>Synthetic KML</name><Point><coordinates>106.81,-6.61,0</coordinates></Point></Placemark>
    </Document></kml>`;
    const kmlParsed = parseKml(kml);
    assert.equal(kmlParsed.length, 1);
    assert.equal(kmlParsed[0].location.lon, 106.81);
    assert.equal(kmlParsed[0].metadata.name, "Synthetic KML");
});

test("ASSETS: spatial index — query radius efisien dan benar", () => {
    const registry = new AssetRegistry();
    const csv = fs.readFileSync(FIXTURE, "utf8");
    importAssets(registry, { format: "csv", data: csv });
    const hits = registry.near({ lat: -6.6, lon: 106.8 }, 60000);
    assert.equal(hits.length, 5);
    hits.sort((a, b) => a.distanceM - b.distanceM);
    // Terdekat adalah SYN-T-001 (jarak ~1km dari titik query).
    assert.equal(hits[0].asset.id, "SYN-T-001");
});

test("ASSETS: watchPolicy per-aset — ring TIDAK di-hard-code sebagai kebenaran universal", () => {
    const policy = canonicalWatchPolicy({
        rings: [
            { name: "immediate", radiusM: 800 },
            { name: "near", radiusM: 2500 }
        ],
        minSeverity: "warning",
        cooldownMs: 60000
    });
    assert.deepEqual(policy.rings.map(r => r.name), ["near", "immediate"]); // urut menurun
    const asset = normalizeAsset({ id: "X1", location: { lat: 0, lon: 0 }, watchPolicy: policy });
    assert.equal(asset.ok, true);
    assert.equal(asset.asset.watchPolicy.minSeverity, "warning");
    // Default ring hanya contoh, bukan kebenaran universal.
    assert.equal(canonicalWatchPolicy({}).rings[0].name, "critical");
});

test("LIGHTNING: nearest strike + ring policy (watch/warning/critical)", () => {
    const registry = new AssetRegistry();
    importAssets(registry, { format: "csv", data: fs.readFileSync(FIXTURE, "utf8") });
    const tower = registry.get("SYN-T-001");
    const strikes = [
        { id: "s1", type: HAZARD_TYPE.LIGHTNING, source: "synthetic", geometry: { type: "point", lat: -6.5905, lon: 106.8005 }, observedAt: NOW - 10000, confidence: 0.9 }, // ~500m critical
        { id: "s2", type: HAZARD_TYPE.LIGHTNING, source: "synthetic", geometry: { type: "point", lat: -6.62, lon: 106.83 }, observedAt: NOW - 20000, confidence: 0.9 } // ~3.9km warning
    ];
    const risk = evaluateLightningRisk(tower, strikes, { nowMs: NOW });
    assert.equal(risk.riskState, "critical");
    assert.equal(risk.ring, "critical");
    assert.ok(risk.nearestStrikeM <= 5000);
    assert.equal(risk.stale, false);
});

test("LIGHTNING: strike basi diturunkan (bukan klaim live) + densitas", () => {
    const registry = new AssetRegistry();
    importAssets(registry, { format: "csv", data: fs.readFileSync(FIXTURE, "utf8") });
    const tower = registry.get("SYN-T-001");
    // Strike TUNGGAL dekat tapi basi (> 1/3 window lalu).
    const staleStrikes = [
        { id: "s1", type: HAZARD_TYPE.LIGHTNING, source: "x", geometry: { type: "point", lat: -6.5905, lon: 106.8005 }, observedAt: NOW - 10 * 60 * 1000, confidence: 0.9 }
    ];
    const risk = evaluateLightningRisk(tower, staleStrikes, { nowMs: NOW, windowMs: 15 * 60 * 1000 });
    assert.equal(risk.stale, true);
    assert.equal(risk.riskState, "watch"); // critical/warning diturunkan
    // Densitas tinggi menaikkan watch → warning.
    const dense = [];
    for (let i = 0; i < 40; i++) {
        dense.push({
            id: `d${i}`, type: HAZARD_TYPE.LIGHTNING, source: "x",
            geometry: { type: "point", lat: -6.65 + (i % 10) * 0.002, lon: 106.85 + Math.floor(i / 10) * 0.002 },
            observedAt: NOW - i * 15000, confidence: 0.9
        });
    }
    const towerB = registry.get("SYN-T-005");
    const denseRisk = evaluateLightningRisk(towerB, dense, { nowMs: NOW, windowMs: 15 * 60 * 1000 });
    assert.ok(denseRisk.densityPerMinute > 2);
    assert.ok(["warning", "critical"].includes(denseRisk.riskState));
});

test("LIGHTNING: tanpa strike relevan → null (tidak mengarang risiko)", () => {
    const registry = new AssetRegistry();
    importAssets(registry, { format: "csv", data: fs.readFileSync(FIXTURE, "utf8") });
    const tower = registry.get("SYN-T-001");
    const far = [{ id: "f1", type: HAZARD_TYPE.LIGHTNING, source: "x", geometry: { type: "point", lat: 0, lon: 0 }, observedAt: NOW, confidence: 0.9 }];
    assert.equal(evaluateLightningRisk(tower, far, { nowMs: NOW }), null);
    assert.equal(evaluateLightningRisk(tower, [], { nowMs: NOW }), null);
});

test("PERFORMANCE: 5000 aset × 200 strike via indeks — bukan O(N×M) penuh", () => {
    const index = new GridIndex(10000);
    for (let i = 0; i < 5000; i++) {
        index.insert(`a${i}`, { lat: -6 + (i % 100) * 0.05, lon: 106 + Math.floor(i / 100) * 0.05 }, i);
    }
    const start = process.hrtime.bigint();
    let hits = 0;
    for (let s = 0; s < 200; s++) {
        hits += index.queryRadius({ lat: -6 + (s % 100) * 0.05, lon: 106 }, 5000).length;
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(hits > 0);
    // 1.000.000 pasangan penuh akan butuh >>200ms; indeks harus jauh di bawah.
    assert.ok(elapsedMs < 1500, `terlalu lambat: ${elapsedMs.toFixed(0)}ms`);
});
