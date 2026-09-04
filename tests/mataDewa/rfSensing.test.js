"use strict";

/**
 * Sertifikasi RF sensing (Phase B) — matriks adversarial + klaim jujur.
 *
 * Bukti wajib:
 *  - Parser: baris/frame valid kedua format, hostil (truncated, len
 *    mismatch, JSON palsu, I/Q ganjil, kolom tak dikenal, magic salah,
 *    payload kurang, ukuran berlebih), MAC tidak pernah bocor.
 *  - Replay source: bounded file, nol frame sah = UNAVAILABLE (MD-009),
 *    cadence monotonic + timeline di masa lampau.
 *  - UDP source: fail-closed tanpa allowLocalUdp; loopback saja.
 *  - Processing: quiet vs motion terpisah; tanpa baseline → presence
 *    null (fail closed); NaN tidak pernah masuk state; window bounded.
 *  - Manager→observasi: skema ketat (reject-not-clamp), lineage sensor
 *    (satu sensor = satu independenceGroup), epistemic INFERRED.
 *  - Watch: hanya observasi geo-located + presence=true + confidence
 *    memadai yang menaikkan severity; stale/rendah-confidence tidak
 *    pernah critical.
 *  - KLAIM: tidak ada jenis observasi rf.* yang menyatakan identitas/
 *    pose/vital; tidak ada field seperti personCount>coarse atau
 *    keypoint di mana pun.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    parseEspCsiCsvLine, parseRuviewFrame, parseNdjsonLine,
    ReplayRfSource, UdpRfSource, CsiRingBuffer,
    CAPTURE_LIMITS, ADR018_MAGIC
} = require("../../src/mataDewa/rf/capture/sources");
const {
    AmplitudeSmoother, PerSessionNormalizer, computeMotionEnergy,
    estimatePresence, RfProcessingSession
} = require("../../src/mataDewa/rf/processing");
const { RfManager } = require("../../src/mataDewa/rf/rfManager");
const { evaluateRfPresenceRisk } = require("../../src/mataDewa/watch/rfPresence");
const { normalizeObservation, OBSERVATION_TYPE } = require("../../src/mataDewa/observations/observation");

const NOW = 1_700_000_000_000;

// ---- Fixture builders -------------------------------------------------------

function espCsiLine({ nsc = 52, seed = 1, mac = "AA:BB:CC:DD:EE:FF", lenOverride = null, variant = "std", tsUs = 12345678 } = {}) {
    const iq = [];
    for (let i = 0; i < nsc; i++) {
        iq.push(((i * 5 * seed) % 16) - 8, ((i * 3 * seed) % 16) - 8);
    }
    const dataField = '"[' + iq.join(",") + ']"';
    if (variant === "c5c6") {
        return `CSI_DATA,7,${mac},-60,72,-98,2,10,6,${tsUs},0,0,${lenOverride ?? iq.length},0,${dataField}`;
    }
    return `CSI_DATA,42,${mac},-55,72,0,6,1,0,0,0,0,0,0,-98,0,11,0,${tsUs},0,0,0,${lenOverride ?? iq.length},0,${dataField}`;
}

function adr018Buffer({ nsc = 52, seq = 7, freqMhz = 2412, rssi = -55, nf = -98, payloadPairs = null } = {}) {
    const pairs = payloadPairs ?? nsc;
    const buf = Buffer.alloc(20 + pairs * 2);
    buf.writeUInt32LE(ADR018_MAGIC, 0);
    buf.writeUInt8(9, 4);
    buf.writeUInt8(1, 5);
    buf.writeUInt16LE(nsc, 6);
    buf.writeUInt32LE(freqMhz, 8);
    buf.writeUInt32LE(seq, 12);
    buf.writeInt8(rssi, 16);
    buf.writeInt8(nf, 17);
    for (let i = 0; i < pairs * 2; i++) buf.writeInt8((i * 7) % 32 - 16, 20 + i);
    return buf;
}

// ---- Parser: esp-csi CSV ----------------------------------------------------

test("RF parser: esp-csi CSV standar + C5/C6 valid → frame sah", () => {
    const std = parseEspCsiCsvLine(espCsiLine({ variant: "std" }));
    assert.equal(std.ok, true);
    assert.equal(std.frame.subcarriers, 52);
    assert.equal(std.frame.rssiDbm, -55);
    assert.equal(std.frame.channel, 11);
    assert.equal(std.frame.noiseFloorDbm, -98);
    // local_timestamp = µs sejak boot → TIDAK pernah jadi epoch dinding.
    assert.equal(std.frame.capturedAtMs, null);
    assert.equal(std.frame.localTimestampUs, 12345678);

    const c56 = parseEspCsiCsvLine(espCsiLine({ variant: "c5c6" }));
    assert.equal(c56.ok, true);
    assert.equal(c56.frame.rssiDbm, -60);
    assert.equal(c56.frame.channel, 6);
});

test("RF parser: esp-csi hostil — truncated, len mismatch, JSON palsu, I/Q ganjil, kolom asing", () => {
    assert.equal(parseEspCsiCsvLine("").ok, false);
    assert.equal(parseEspCsiCsvLine("CSI_DATA,1").ok, false);
    assert.equal(parseEspCsiCsvLine("RANDOM,1,2,3").ok, false);
    assert.equal(parseEspCsiCsvLine(espCsiLine({ lenOverride: 99 })).ok, false, "len ≠ elemen ditolak");
    // JSON palsu: head standar sah, data bukan JSON.
    assert.equal(parseEspCsiCsvLine('CSI_DATA,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,"notjson"').ok, false);
    // I/Q ganjil: jumlah elemen ganjil → pasangan tidak lengkap → ditolak.
    assert.equal(parseEspCsiCsvLine('CSI_DATA,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,3,0,"[1,2,3]"').ok, false);
    // Kolom metadata tak dikenal (bukan 24 / 14).
    assert.equal(parseEspCsiCsvLine('CSI_DATA,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,"[1,2]"').ok, false);
    // Oversize line.
    assert.equal(parseEspCsiCsvLine("CSI_DATA," + "9".repeat(70 * 1024)).ok, false);
});

test("RF parser: MAC perangkat TIDAK pernah muncul di frame kanonik", () => {
    const result = parseEspCsiCsvLine(espCsiLine({ mac: "DE:AD:BE:EF:00:11" }));
    assert.equal(result.ok, true);
    const json = JSON.stringify(result.frame, (k, v) => ArrayBuffer.isView(v) ? "[view]" : v);
    assert.equal(json.includes("DE:AD"), false);
    assert.equal(json.includes("BE:EF"), false);
});

// ---- Parser: RuView ADR-018 biner -------------------------------------------

test("RF parser: ADR-018 valid + hostil (magic salah, payload kurang, subcarrier 0/oversize)", () => {
    const good = parseRuviewFrame(adr018Buffer({ nsc: 52, seq: 99 }));
    assert.equal(good.ok, true);
    assert.equal(good.frame.sequence, 99);
    assert.equal(good.frame.subcarriers, 52);
    assert.equal(good.frame.channel, 1); // 2412 MHz
    assert.equal(good.frame.rssiDbm, -55);

    // Magic salah.
    const badMagic = adr018Buffer();
    badMagic.writeUInt32LE(0xdeadbeef, 0);
    assert.equal(parseRuviewFrame(badMagic).ok, false);
    // Terlalu pendek.
    assert.equal(parseRuviewFrame(Buffer.alloc(10)).ok, false);
    // Payload I/Q kurang dari subcarrier yang diklaim.
    assert.equal(parseRuviewFrame(adr018Buffer({ nsc: 52, payloadPairs: 10 })).ok, false);
    // Subcarrier 0.
    assert.equal(parseRuviewFrame(adr018Buffer({ nsc: 0, payloadPairs: 4 })).ok, false);
    // Subcarrier oversize.
    assert.equal(parseRuviewFrame(adr018Buffer({ nsc: CAPTURE_LIMITS.MAX_SUBCARRIERS + 1, payloadPairs: CAPTURE_LIMITS.MAX_SUBCARRIERS + 1 })).ok, false);
    // Frame oversize.
    assert.equal(parseRuviewFrame(Buffer.alloc(CAPTURE_LIMITS.MAX_FRAME_BYTES + 1)).ok, false);
    // Bukan Buffer.
    assert.equal(parseRuviewFrame("bukan").ok, false);
});

test("RF parser: NDJSON valid + hostil", () => {
    const good = parseNdjsonLine(JSON.stringify({ amplitude: [1, 2, 3, 4], rssiDbm: -50, channel: 6, capturedAtMs: NOW }));
    assert.equal(good.ok, true);
    assert.equal(good.frame.subcarriers, 4);
    assert.equal(good.frame.capturedAtMs, NOW);

    assert.equal(parseNdjsonLine("bukan json").ok, false);
    assert.equal(parseNdjsonLine(JSON.stringify([1, 2])).ok, false);
    assert.equal(parseNdjsonLine(JSON.stringify({ amplitude: [] })).ok, false);
    assert.equal(parseNdjsonLine(JSON.stringify({ amplitude: [1, NaN] })).ok, false);
    assert.equal(parseNdjsonLine(JSON.stringify({ amplitude: new Array(2000).fill(1) })).ok, false);
});

// ---- Replay source -----------------------------------------------------------

test("RF replay: file bounded; nol frame sah → UNAVAILABLE (MD-009)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-"));
    const empty = path.join(dir, "empty.csi.csv");
    fs.writeFileSync(empty, "baris-sampah\nbaris-lain\n");
    const src = new ReplayRfSource({ id: "r", sensorId: "s", filePath: empty, maxRateHz: 1000 });
    const result = await src.load();
    assert.equal(result.ok, false);
    assert.equal(src.state, "unavailable");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("RF replay: timeline monotonik di masa lampau; cadence dihormati", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, Array.from({ length: 12 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const src = new ReplayRfSource({ id: "r", sensorId: "s", filePath: file, maxRateHz: 1000 });
    const stamps = [];
    const result = await src.load({ onFrame: (f) => stamps.push(f.capturedAtMs) });
    assert.equal(result.ok, true);
    assert.equal(result.framesAccepted, 12);
    const now = Date.now();
    for (const t of stamps) {
        assert.ok(t <= now, "replay tidak boleh menulis masa depan");
    }
    for (let i = 1; i < stamps.length; i++) {
        assert.ok(stamps[i] > stamps[i - 1], "timeline harus monotonik naik");
    }
    assert.equal(src.state, "available");
    fs.rmSync(dir, { recursive: true, force: true });
});

test("RF replay: file raksasa ditolak sebelum dibaca", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-"));
    const file = path.join(dir, "big.csi.csv");
    fs.writeFileSync(file, "x".repeat(101 * 1024 * 1024).slice(0, 1024)); // sparse-ish; ukuran >100MB tak realistis di tmp — pakai maxBytes kecil
    const src = new ReplayRfSource({ id: "r", sensorId: "s", filePath: file, maxRateHz: 1000 });
    const result = await src.load({ maxBytes: 10 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /melebihi batas/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---- UDP source --------------------------------------------------------------

test("RF UDP: fail-closed tanpa allowLocalUdp; non-loopback ditolak", async () => {
    const denied = new UdpRfSource({ id: "u1", sensorId: "s" });
    const r1 = await denied.start();
    assert.equal(r1.ok, false);
    assert.match(r1.reason, /fail-closed|allowLocalUdp/);

    const nonLoopback = new UdpRfSource({ id: "u2", sensorId: "s", allowLocalUdp: true, bindAddress: "0.0.0.0" });
    const r2 = await nonLoopback.start();
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /loopback/);

    const ok = new UdpRfSource({ id: "u3", sensorId: "s", allowLocalUdp: true });
    const r3 = await ok.start();
    assert.equal(r3.ok, true);
    ok.stop();
});

// ---- Processing ---------------------------------------------------------------

test("RF processing: quiet vs motion terpisah jelas", () => {
    const session = new RfProcessingSession({ sensorId: "s", captureSession: "c" });
    // Quiet: amplitudo konstan.
    for (let i = 0; i < 40; i++) session.update({ amplitude: new Float32Array(52).fill(10) });
    const quiet = session.describe().lastEstimate;
    assert.equal(quiet.presence, false);

    // Motion: amplitudo berubah besar.
    for (let i = 0; i < 40; i++) {
        const amp = new Float32Array(52);
        for (let sc = 0; sc < 52; sc++) amp[sc] = 10 + Math.sin(i / 3) * 8 + (sc % 5);
        session.update({ amplitude: amp });
    }
    const motion = session.describe().lastEstimate;
    assert.equal(motion.presence, true);
    assert.ok(motion.motionEnergy > quiet.motionEnergy);
});

test("RF processing: tanpa baseline → presence null (fail closed, tidak dikarang)", () => {
    const motion = computeMotionEnergy(
        Array.from({ length: 20 }, () => new Float32Array(52).fill(5)));
    const estimate = estimatePresence(motion, { quietBaseline: null });
    assert.equal(estimate, null);
    // Baseline negatif/NaN juga ditolak.
    assert.equal(estimatePresence(motion, { quietBaseline: -1 }), null);
    assert.equal(estimatePresence(motion, { quietBaseline: NaN }), null);
});

test("RF processing: NaN/Infinity tidak pernah masuk state smoother", () => {
    const smoother = new AmplitudeSmoother();
    const first = smoother.next(new Float32Array([1, 2, 3]));
    assert.ok(first.every(Number.isFinite));
    const second = smoother.next(new Float32Array([NaN, Infinity, 4]));
    assert.ok(second.every(Number.isFinite), "NaN/Infinity tidak boleh menular");
    assert.equal(second[1], first[1], "nilai tak-sah mempertahankan state sebelumnya");
});

test("RF processing: window bounded; sesi reset bersih", () => {
    const session = new RfProcessingSession({ sensorId: "s", captureSession: "c", maxWindowFrames: 10 });
    for (let i = 0; i < 200; i++) session.update({ amplitude: new Float32Array(52).fill(i) });
    assert.ok(session.window.length <= 10);
    session.reset();
    assert.equal(session.framesProcessed, 0);
    assert.equal(session.quietBaseline, null);
});

test("RF processing: terlalu sedikit subcarrier sah → motion null", () => {
    const few = Array.from({ length: 20 }, () => new Float32Array(4).fill(5));
    assert.equal(computeMotionEnergy(few), null);
});

// ---- Manager → observasi ------------------------------------------------------

test("RF manager: observasi kanonik ketat — epistemic INFERRED, lineage sensor, reject-not-clamp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, Array.from({ length: 12 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW }, allowLocalUdp: false });
    manager.addReplaySource({ id: "r1", sensorId: "sensor-alpha", filePath: file, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    const collected = [];
    await manager.loadReplay("r1", { onObservations: (obs) => collected.push(obs) });
    assert.ok(collected.length > 0);
    for (const obs of collected) {
        assert.equal(Object.isFrozen(obs), true);
        assert.equal(obs.epistemic, "INFERRED");
        assert.equal(obs.lineage.kind, "sensor");
        assert.equal(obs.lineage.sensorId, "sensor-alpha");
        assert.equal(obs.lineage.independenceGroup, "sensor-alpha");
        assert.ok(obs.confidence >= 0 && obs.confidence <= 1);
        assert.ok(obs.type === OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE ||
            obs.type === OBSERVATION_TYPE.RF_MOTION_ESTIMATE);
    }
    // Dua sumber dengan sensor sama = satu grup kemandirian.
    const file2 = path.join(dir, "ok2.csi.csv");
    fs.writeFileSync(file2, Array.from({ length: 8 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    manager.addReplaySource({ id: "r2", sensorId: "sensor-alpha", filePath: file2, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    const collected2 = [];
    await manager.loadReplay("r2", { onObservations: (obs) => collected2.push(obs) });
    assert.equal(collected2[0].lineage.independenceGroup, collected[0].lineage.independenceGroup);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("RF manager: sumber tanpa lokasi sensor ditolak (sistem spasial menuntut geo)", () => {
    const manager = new RfManager({ clock: { nowMs: () => NOW } });
    const noLoc = manager.addReplaySource({ id: "r", sensorId: "s", filePath: "/tmp/x.csi.csv" });
    assert.equal(noLoc.ok, false);
    assert.match(noLoc.reason, /location/);
    const badLoc = manager.addReplaySource({ id: "r", sensorId: "s", filePath: "/tmp/x.csi.csv", location: { lat: NaN, lon: 0 } });
    assert.equal(badLoc.ok, false);
});

test("RF manager: UDP ditolak tanpa opt-in; estimasi ditolak ketat tidak dipaksa", () => {
    const manager = new RfManager({ clock: { nowMs: () => NOW }, allowLocalUdp: false });
    const refused = manager.addUdpSource({ id: "u", sensorId: "s" });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /fail-closed|allowLocalUdp/);
});

// ---- Watch integration ---------------------------------------------------------

test("RF watch: hanya presence=true + geo-located + INFERRED yang menaikkan severity", () => {
    const asset = {
        id: "a", geometry: { type: "point", lat: -6.6, lon: 106.8 },
        watchPolicy: { rings: [{ name: "critical", radiusM: 100 }, { name: "warning", radiusM: 500 }, { name: "watch", radiusM: 2000 }] }
    };
    const mk = (over = {}) => normalizeObservation({
        source: "mataDewa.rf:s1", type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        location: { lat: -6.6, lon: 106.8 },
        observedAt: NOW - 1000, confidence: 0.8, epistemic: "INFERRED",
        attributes: { presence: true, sensorLat: -6.6, sensorLon: 106.8 },
        ...over
    }, { nowMs: NOW }).observation;

    // MD-010: observasi TANPA trusted live seal (dibuat publik) maksimal
    // "watch" — coarse/experimental, tidak pernah produksi-critical.
    const good = evaluateRfPresenceRisk(asset, [mk()], { nowMs: NOW, windowMs: 30000 });
    assert.ok(good);
    assert.equal(good.riskState, "watch");
    assert.equal(good.severity, "watch");
    assert.equal(good.productionAlert, false);

    // presence=false → tidak menaikkan.
    const absent = evaluateRfPresenceRisk(asset, [mk({ attributes: { presence: false, sensorLat: -6.6, sensorLon: 106.8 } })], { nowMs: NOW, windowMs: 30000 });
    assert.equal(absent, null);

    // Tanpa lokasi sensor → fail closed.
    const noGeo = mk({ attributes: { presence: true } });
    assert.equal(evaluateRfPresenceRisk(asset, [noGeo], { nowMs: NOW, windowMs: 30000 }), null);

    // OBSERVED (bukan INFERRED) → ditolak (bukan estimasi).
    const wrongEpistemic = mk({ epistemic: "OBSERVED" });
    assert.equal(evaluateRfPresenceRisk(asset, [wrongEpistemic], { nowMs: NOW, windowMs: 30000 }), null);

    // F: sensor di 0,0 tetap geo-valid (bukan gagal truthiness).
    const zeroPoint = mk({ attributes: { presence: true, sensorLat: 0, sensorLon: 0 } });
    // Jauh dari aset (-6.6,106.8) → di luar radius, bukan ditolak truthiness.
    const zeroEval = evaluateRfPresenceRisk(asset, [zeroPoint], { nowMs: NOW, windowMs: 30000 });
    assert.equal(zeroEval, null);

    // Stale → tetap watch (tidak pernah naik).
    const stale = mk({ observedAt: NOW - 29 * 1000 });
    const staleEval = evaluateRfPresenceRisk(asset, [stale], { nowMs: NOW, windowMs: 30000 });
    assert.ok(staleEval);
    assert.notEqual(staleEval.severity, "critical");

    // Confidence rendah → tetap watch.
    const lowConf = mk({ confidence: 0.3 });
    const lowEval = evaluateRfPresenceRisk(asset, [lowConf], { nowMs: NOW, windowMs: 30000 });
    assert.ok(lowEval);
    assert.notEqual(lowEval.severity, "critical");
});

// ---- KLAIM JUJUR (scan struktural) ---------------------------------------------

test("RF klaim: tidak ada identitas/pose/vital di vocabulary atau output", () => {
    const fsSrc = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "mataDewa", "rf", "processing.js"), "utf8");
    const mgrSrc = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "mataDewa", "rf", "rfManager.js"), "utf8");
    const watchSrc = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "mataDewa", "watch", "rfPresence.js"), "utf8");
    const combined = fsSrc + mgrSrc + watchSrc;
    // Kata yang menandakan klaim terlarang muncul HANYA di komentar penolakan.
    const codeOnly = combined
        .split("\n")
        .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
    assert.equal(/identity|keypoint|heart.?rate|breathing|pose/i.test(codeOnly), false,
        "kode RF tidak boleh menyebut klaim identitas/pose/vital");
});

test("RF klaim: observasi rf.* tidak punya field personCount/detail melebihi coarse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-test-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, espCsiLine() + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW } });
    manager.addReplaySource({ id: "r", sensorId: "s", filePath: file, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    return manager.loadReplay("r", { onObservations: () => {} }).then(async () => {
        const status = manager.status();
        for (const session of status.sessions) {
            const est = session.lastEstimate;
            if (!est) continue;
            const keys = Object.keys(est);
            for (const key of keys) {
                assert.equal(/identity|pose|keypoint|heart|breath/i.test(key), false);
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ---- Ring buffer ---------------------------------------------------------------

test("RF ring buffer: kapasitas dihormati, buang terlama", () => {
    const ring = new CsiRingBuffer({ capacity: 5 });
    for (let i = 0; i < 20; i++) ring.push({ n: i });
    assert.equal(ring.size, 5);
    assert.equal(ring.dropped, 15);
    assert.deepEqual(ring.latest(2).map(f => f.n), [18, 19]);
});
