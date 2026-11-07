"use strict";

/**
 * Sertifikasi MD-003 — impor hostil dibatasi.
 *
 * Bukti wajib: CSV hostile (kutipan/koma/baris baru/sel raksasa/kolom/
 * baris/encoding), GeoJSON hostil (kedalaman, bomb koordinat, tipe
 * MULTI* jujur ditolak, ring tak tertutup, prototype berbahaya),
 * KML XXE (DOCTYPE/ENTITY ditolak), kedalaman XML, KMZ zip sungguhan
 * (traversal, bomb, rasio, path absolut, duplikat), JSON depth bomb.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, parseKml, parseGeoJson, parseXmlElements, parseKmz, importAssets, importAssetsAsync } = require("../../src/mataDewa/assets/importers");
const { resolveImportLimits } = require("../../src/mataDewa/assets/importLimits");
const { AssetRegistry } = require("../../src/mataDewa/assets/assetRegistry");

test("MD-003 LIMITS: plafon tidak bisa dinaikkan siapa pun", () => {
    const limits = resolveImportLimits({ MAX_FEATURES: 10_000_000, MAX_ZIP_RATIO: 999_999 });
    // Override di atas plafon DITOLAK → jatuh ke default keras.
    assert.equal(limits.MAX_FEATURES, 50000);
    assert.equal(limits.MAX_ZIP_RATIO, 200);
    // Override dalam plafon dihormati.
    const tuned = resolveImportLimits({ MAX_FEATURES: 1000 });
    assert.equal(tuned.MAX_FEATURES, 1000);
    assert.equal(Object.isFrozen(limits), true);
});

test("MD-003 CSV: sel raksasa, terlalu banyak kolom, terlalu banyak baris ditolak", () => {
    // Sel raksasa.
    const bigCell = "A".repeat(10000);
    assert.throws(() => parseCsv(`id,lat,lon\n1,0,${bigCell}`), /IMPORT_LIMIT_EXCEEDED/);
    // Terlalu banyak kolom.
    const manyCols = Array.from({ length: 300 }, (_, i) => `c${i}`).join(",");
    const manyVals = Array.from({ length: 300 }, (_, i) => i).join(",");
    assert.throws(() => parseCsv(`${manyCols}\n${manyVals}`), /IMPORT_LIMIT_EXCEEDED/);
    // Terlalu banyak baris.
    const rows = ["id,lat,lon"];
    for (let i = 0; i < 100002; i++) rows.push(`${i},${i * 0.001},106`);
    assert.throws(() => parseCsv(rows.join("\n")), /IMPORT_LIMIT_EXCEEDED/);
});

test("MD-003 CSV: kutipan ganda, koma & baris baru tertanam diurai dengan benar", () => {
    const rows = parseCsv('id,lat,lon,name\n"A,1",0,106,"multi\nline"');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.name, "multi\nline");
    assert.equal(rows[0].id, "A,1");
});

test("MD-003 CSV: NaN/Infinity koordinat ditolak diam-diam (skip) bukan diklaim", () => {
    const rows = parseCsv("id,lat,lon\nA,NaN,106\nB,Infinity,106\nC,0,106\nD,abc,106");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "C");
});

test("MD-003 CSV: encoding rusak (latin1 byte) tidak crash — diperlakukan sebagai string", () => {
    const broken = Buffer.from([0x69, 0x64, 0x2c, 0x6c, 0x61, 0x74, 0x2c, 0x6c, 0x6f, 0x6e, 0x0a, 0x58, 0x2c, 0x30, 0x2c, 0xff, 0xfe]).toString("latin1");
    const rows = parseCsv(broken);
    assert.ok(Array.isArray(rows));
});

test("MD-003 GeoJSON: tipe MULTI* ditolak jujur (bukan diam-diam dilewati semua)", () => {
    const gj = JSON.stringify({
        type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[]]]] }, properties: {}
    });
    const parsed = parseGeoJson(gj);
    assert.equal(parsed.length, 0); // MultiPolygon tidak diklaim sebagai didukung
});

test("MD-003 GeoJSON: ring poligon tak tertutup ditolak, jumlah ring dibatasi", () => {
    const open = JSON.stringify({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1]]] },
        properties: {}
    });
    // Ring tak tertutup = geometri tidak sah → fitur TIDAK diimpor
    // (bukan diklaim sebagai aset dengan geometri karangan).
    assert.equal(parseGeoJson(open).length, 0);
    // Poligon tertutup sah tetap diterima.
    const closed = JSON.stringify({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[106, -6], [107, -6], [107, -5], [106, -6]]] },
        properties: { id: "POLY-OK" }
    });
    assert.equal(parseGeoJson(closed).length, 1);

    const manyRings = {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [] },
        properties: {}
    };
    for (let i = 0; i < 70; i++) {
        manyRings.geometry.coordinates.push([[0, 0], [1, 0], [1, 1], [0, 0]]);
    }
    assert.throws(() => parseGeoJson(manyRings), /IMPORT_LIMIT_EXCEEDED/);
});

test("MD-003 GeoJSON: bomb koordinat ditolak; kedalaman geometri dibatasi", () => {
    // Jumlah koordinat raksasa.
    const many = [];
    for (let i = 0; i < 30000; i++) many.push([i * 0.001, 0]);
    const bomb = { type: "Feature", geometry: { type: "LineString", coordinates: many }, properties: {} };
    assert.throws(() => parseGeoJson(bomb), /IMPORT_LIMIT_EXCEEDED/);

    // Kedalaman geometri lewat batas.
    let deep = [106, -6];
    for (let i = 0; i < 8; i++) deep = [deep];
    assert.throws(() => parseGeoJson({ type: "Feature", geometry: { type: "Polygon", coordinates: deep }, properties: {} }), /IMPORT_LIMIT_EXCEEDED|geometri/);
});

test("MD-003 GeoJSON: prototype berbahaya (class instance) ditolak", () => {
    class Evil { constructor() { this.type = "Feature"; } }
    const evil = new Evil();
    evil.geometry = { type: "Point", coordinates: [106, -6] };
    evil.properties = {};
    assert.throws(() => parseGeoJson(evil), /tidak sah/);

    // Getter hostil → tolak (bukan eksekusi getter).
    const withGetter = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [106, -6] },
        properties: {}
    };
    Object.defineProperty(withGetter.properties, "evil", {
        get() { throw new Error("GETTER_EXECUTED"); }, enumerable: true
    });
    assert.throws(() => parseGeoJson(withGetter), /getter|tidak sah/i);
});

test("MD-003 KML: XXE (DOCTYPE/ENTITY) ditolak keras", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<kml><Document><Placemark><name>&xxe;</name><Point><coordinates>106,-6</coordinates></Point></Placemark></Document></kml>`;
    assert.throws(() => parseKml(xxe), /DOCTYPE|XXE/i);
    const paramEntity = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY % remote SYSTEM "http://evil.invalid/x.dtd">%remote;]>
<kml><Placemark><Point><coordinates>106,-6</coordinates></Point></Placemark></kml>`;
    assert.throws(() => parseKml(paramEntity), /DOCTYPE|XXE/i);
});

test("MD-003 KML: kedalaman XML, jumlah elemen, entitas tak dikenal ditolak", () => {
    // Kedalaman berlebih.
    let deep = "<coordinates>106,-6</coordinates>";
    for (let i = 0; i < 40; i++) deep = `<a${i}>${deep}</a${i}>`;
    assert.throws(() => parseKml(`<kml>${deep}</kml>`), /IMPORT_LIMIT_EXCEEDED/);

    // Entitas numerik/kustom tidak diurai (bukan dieksekusi).
    assert.throws(
        () => parseKml("<kml><Placemark><name>&custom;.</name><Point><coordinates>106,-6</coordinates></Point></Placemark></kml>"),
        /entitas/);
    // Bukti aman: parser memakai decode 5 entitas pradefinisi saja.
    const ok = parseKml("<kml><Placemark><name>A &amp; B &lt;C&gt;</name><Point><coordinates>106,-6</coordinates></Point></Placemark></kml>");
    assert.equal(ok[0].metadata.name, "A & B <C>");
});

test("MD-003 KML: struktur rusak (tag tak seimbang) ditolak — bukan regex terhadap file hostil", () => {
    assert.throws(() => parseKml("<kml><Placemark><Point><coordinates>106,-6</coordinates></Placemark></kml>"), /seimbang|ditutup/i);
    assert.throws(() => parseKml("<kml><Placemark>belum ditutup"), /ditutup/i);
});

test("MD-003 XML: scanner bounded menangkap tag tidak seimbang & kedalaman", () => {
    const limits = resolveImportLimits();
    assert.throws(() => parseXmlElements("<a><b></a></b>", limits), /seimbang/);
    let deep = "x";
    for (let i = 0; i < 40; i++) deep = `<d${i}>${deep}</d${i}>`;
    assert.throws(() => parseXmlElements(deep, limits), /IMPORT_LIMIT_EXCEEDED/);
});

test("MD-003 KMZ: entry .kml sungguhan dibaca (inflasi ZIP nyata)", async () => {
    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("doc.kml", '<?xml version="1.0"?><kml><Document><Placemark><name>Z</name><Point><coordinates>106.8,-6.6</coordinates></Point></Placemark></Document></kml>');
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const kmlText = await parseKmz(buffer);
    const placemarks = parseKml(kmlText);
    assert.equal(placemarks.length, 1);
    assert.equal(placemarks[0].metadata.name, "Z");
});

test("MD-003 KMZ: path traversal, path absolut, duplikat path ditolak", async () => {
    const JSZip = require("jszip");
    // Traversal — nama mentah di central directory dipertahankan oleh
    // jszip saat loadAsync (diverifikasi: "../evil.kml" tetap terlihat
    // ternormalisasi di files map; scanner RAW menangkap bentuk aslinya).
    const z1 = new JSZip();
    z1.file("../evil.kml", "<kml></kml>");
    const b1 = await z1.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => parseKmz(b1), /traversal/);
    // Absolut.
    const z2 = new JSZip();
    z2.file("/abs/evil.kml", "<kml></kml>");
    const b2 = await z2.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => parseKmz(b2), /absolut/);
    // Duplikat (dua nama berbeda yang ternormalisasi sama).
    const z3 = new JSZip();
    z3.file("doc.kml", "<kml></kml>");
    z3.file("./doc.kml", "<kml></kml>");
    const b3 = await z3.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => parseKmz(b3), /duplikat/);
});

test("MD-003 KMZ: zip bomb (rasio ekspansi) ditolak", async () => {
    const JSZip = require("jszip");
    const zip = new JSZip();
    // Rasio >> 200: 30 MB nol terkompresi kecil.
    zip.file("doc.kml", "<kml>" + "0".repeat(30 * 1024 * 1024) + "</kml>");
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    if (buffer.length > 20 * 1024 * 1024) return; // arsip besar tak praktis untuk CI — lewati
    await assert.rejects(() => parseKmz(buffer), /IMPORT_LIMIT_EXCEEDED/);
});

test("MD-003 KMZ: bukan ZIP / tanpa .kml ditolak jujur", async () => {
    await assert.rejects(() => parseKmz(Buffer.from("bukan zip")), /ZIP/);
    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("readme.txt", "tidak ada kml");
    const b = await zip.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => parseKmz(b), /\.kml/);
});

test("MD-003 KMZ: impor async end-to-end ke registry", async () => {
    const JSZip = require("jszip");
    const zip = new JSZip();
    zip.file("doc.kml", '<kml><Document><Placemark><name>SYN-KMZ</name><Point><coordinates>106.81,-6.61</coordinates></Point></Placemark></Document></kml>');
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    const registry = new AssetRegistry();
    const result = await importAssetsAsync(registry, { format: "kmz", data: buffer, source: "synthetic" });
    assert.equal(result.imported.length, 1);
    assert.equal(registry.size, 1);
});

test("MD-003 JSON depth bomb — ditolak fail-closed tanpa hang", () => {
    // Melebihi batas ukuran → LIMIT sebelum parse.
    assert.throws(() => parseGeoJson("[".repeat(21 * 1024 * 1024)), /IMPORT_LIMIT_EXCEEDED/);
    // Dalam batas ukuran tapi depth bomb → ditolak apa pun errornya
    // (LIMIT kedalaman / SyntaxError / RangeError stack) — yang penting
    // TIDAK hang dan TIDAK mengembalikan data.
    let threw = false;
    try {
        parseGeoJson("[".repeat(100000) + "]".repeat(100000));
    }
    catch { threw = true; }
    assert.equal(threw, true);
});

test("MD-003 impor sinkron KMZ menolak dengan instruksi (bukan fallback fake)", () => {
    const registry = new AssetRegistry();
    assert.throws(() => importAssets(registry, { format: "kmz", data: Buffer.from("x") }), /importAssetsAsync/);
});
