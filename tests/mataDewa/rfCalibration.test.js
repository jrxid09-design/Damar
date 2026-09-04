"use strict";

/**
 * MD-014 — RF CALIBRATION LIFECYCLE (adversarial matrix).
 *
 * Bukti wajib:
 *  - State machine: UNCALIBRATED → COLLECTING → CALIBRATED → STALE,
 *    NOISY/INVALID/RECALIBRATION_REQUIRED tercapai dari kondisi nyata.
 *  - NO VALID BASELINE → TIDAK ada inferensi produksi (usable=false).
 *  - Binding: perubahan sensor/sesi/sourceKind/channel = kalibrasi BERBEDA.
 *    Baseline TIDAK PERNAH menyeberang (replay ↔ live terpisah).
 *  - Metrik kualitas: NaN/Infinity/negatif/sampel nol/noise berlebih →
 *    REJECT (bukan clamp, bukan angka direkayasa).
 *  - Tidak ada raw buffer/frame yang keluar dari modul kalibrasi.
 *  - Manager: kalibrasi mengikuti sesi sumber; metadata bounded menempel
 *    pada observasi; invalidasi eksplisit menaikkan generation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    RfCalibration, CALIBRATION_STATE, CALIBRATION_LIMITS, calibrationBindingKey,
    buildCalibrationQuality
} = require("../../src/mataDewa/rf/calibration");
const { RfManager } = require("../../src/mataDewa/rf/rfManager");
const { isTrustedLiveRfObservation } = require("../../src/mataDewa/rf/rfTrust");

const NOW = 1_700_000_000_000;

function makeCalibration(over = {}) {
    return new RfCalibration({
        sensorId: "s1", captureSession: "cs-1", sourceKind: "replay",
        clock: { nowMs: () => NOW }, ...over
    });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test("MD-014: lifecycle UNCALIBRATED → COLLECTING → CALIBRATED", () => {
    const cal = makeCalibration();
    assert.equal(cal.state, CALIBRATION_STATE.UNCALIBRATED);
    for (let i = 0; i < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES - 1; i++) {
        cal.recordFrameEnergy(0.001);
    }
    assert.equal(cal.state, CALIBRATION_STATE.COLLECTING);
    cal.recordFrameEnergy(0.0012);
    const meta = cal.finalizeBaseline();
    assert.equal(meta.state, CALIBRATION_STATE.CALIBRATED);
    assert.equal(cal.observationMetadata().calibrationState, "calibrated");
    assert.ok(cal.observationMetadata().calibrationQuality !== null);
    assert.ok(cal.isUsableForProductionInference({ nowMs: NOW }));
});

test("MD-014: CALIBRATED → STALE after TTL", () => {
    let now = NOW;
    const cal = new RfCalibration({
        sensorId: "s1", captureSession: "cs-1", sourceKind: "replay",
        clock: { nowMs: () => now }, ttlMs: 60_000
    });
    for (let i = 0; i < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES; i++) cal.recordFrameEnergy(0.001);
    cal.finalizeBaseline();
    assert.equal(cal.state, CALIBRATION_STATE.CALIBRATED);
    now += 61_000;
    assert.equal(cal.effectiveState(), CALIBRATION_STATE.STALE);
    assert.equal(cal.observationMetadata().calibrationState, "stale");
    assert.equal(cal.observationMetadata().calibrationQuality, null,
        "stale calibration exposes NO quality numbers");
    assert.equal(cal.isUsableForProductionInference({ nowMs: now }), false);
});

test("MD-014: noisy samples → NOISY (baseline rejected, not clamped)", () => {
    const cal = makeCalibration();
    // Baseline kecil tapi noise (deviasi) sangat besar → NOISY.
    const samples = [0.0001, 0.0002, 0.0001, 0.0002, 1.0];
    for (const s of samples) cal.recordFrameEnergy(s);
    const meta = cal.finalizeBaseline();
    assert.equal(meta.state, CALIBRATION_STATE.NOISY);
    assert.equal(cal.observationMetadata().calibrationQuality, null);
    assert.equal(cal.isUsableForProductionInference({ nowMs: NOW }), false);
});

test("MD-014: NaN/Infinity/negative sample → INVALID (reject, not ignore)", () => {
    for (const bad of [NaN, Infinity, -Infinity, -0.5]) {
        const cal = makeCalibration();
        cal.recordFrameEnergy(bad);
        assert.equal(cal.state, CALIBRATION_STATE.INVALID, `sample ${bad} must invalidate`);
        assert.equal(cal.isUsableForProductionInference({ nowMs: NOW }), false);
    }
});

test("MD-014: invalidated calibration cannot silently become valid again", () => {
    const cal = makeCalibration();
    cal.recordFrameEnergy(NaN);
    assert.equal(cal.state, CALIBRATION_STATE.INVALID);
    cal.recordFrameEnergy(0.001); // new samples after invalidation
    assert.notEqual(cal.state, CALIBRATION_STATE.CALIBRATED);
    const meta = cal.finalizeBaseline();
    assert.notEqual(meta.state, CALIBRATION_STATE.CALIBRATED);
});

test("MD-014: invalidate() → RECALIBRATION_REQUIRED + generation bump + samples wiped", () => {
    const cal = makeCalibration();
    for (let i = 0; i < 10; i++) cal.recordFrameEnergy(0.001);
    cal.finalizeBaseline();
    assert.ok(cal.isUsableForProductionInference({ nowMs: NOW }));
    const before = cal.describe();
    const meta = cal.invalidate({ reason: "binding_changed" });
    assert.equal(meta.state, CALIBRATION_STATE.RECALIBRATION_REQUIRED);
    assert.equal(meta.sampleCount, 0);
    assert.equal(meta.generation, before.generation + 1);
    assert.equal(cal.observationMetadata().calibrationGeneration, before.generation + 1);
    assert.equal(cal.isUsableForProductionInference({ nowMs: NOW }), false);
});

test("MD-014: zero samples → no claim (UNCALIBRATED, quality null)", () => {
    const cal = makeCalibration();
    const meta = cal.finalizeBaseline();
    assert.equal(meta.state, CALIBRATION_STATE.UNCALIBRATED);
    assert.equal(cal.observationMetadata().calibrationQuality, null);
});

// ---------------------------------------------------------------------------
// Binding isolation
// ---------------------------------------------------------------------------

test("MD-014: binding key separates sensor/session/sourceKind/channel", () => {
    const base = calibrationBindingKey({ sensorId: "s1", captureSession: "cs1", sourceKind: "replay" });
    assert.equal(base, calibrationBindingKey({ sensorId: "s1", captureSession: "cs1", sourceKind: "replay" }));
    assert.notEqual(base, calibrationBindingKey({ sensorId: "s2", captureSession: "cs1", sourceKind: "replay" }));
    assert.notEqual(base, calibrationBindingKey({ sensorId: "s1", captureSession: "cs2", sourceKind: "replay" }));
    assert.notEqual(base, calibrationBindingKey({ sensorId: "s1", captureSession: "cs1", sourceKind: "udp" }),
        "replay and live NEVER share a calibration binding");
    assert.notEqual(base, calibrationBindingKey({ sensorId: "s1", captureSession: "cs1", sourceKind: "replay", channel: 11 }));
    assert.notEqual(base, calibrationBindingKey({ sensorId: "s1", captureSession: "cs1", sourceKind: "replay", channel: 6 }));
});

test("MD-014: two calibrations with different bindings never share baseline state", () => {
    const a = makeCalibration({ sensorId: "s1", captureSession: "cs-a", sourceKind: "replay" });
    const b = makeCalibration({ sensorId: "s1", captureSession: "cs-b", sourceKind: "udp" });
    for (let i = 0; i < 10; i++) a.recordFrameEnergy(0.001);
    a.finalizeBaseline();
    assert.ok(a.isUsableForProductionInference({ nowMs: NOW }));
    assert.equal(b.state, CALIBRATION_STATE.UNCALIBRATED,
        "live calibration does not inherit replay baseline");
    assert.notEqual(a.binding, b.binding);
});

// ---------------------------------------------------------------------------
// Quality metric rejection (strict, not clamped)
// ---------------------------------------------------------------------------

test("MD-014: quality builder rejects non-finite / negative / too-few samples", () => {
    for (const over of [
        { sampleCount: 0 },
        { sampleCount: NaN },
        { sampleCount: Infinity },
        { baselineMetric: NaN },
        { baselineMetric: Infinity },
        { noiseMetric: -1 },
        { createdAtMs: -1 },
        { ttlMs: 25 * 60 * 60 * 1000 } // > 24h bound
    ]) {
        assert.throws(() => buildCalibrationQuality({
            sampleCount: 10, baselineMetric: 0.001, noiseMetric: 0.0001,
            createdAtMs: NOW, lastValidatedAtMs: NOW, ttlMs: 30 * 60 * 1000,
            ...over
        }), /.+/, `over ${JSON.stringify(over)} must reject`);
    }
    assert.throws(() => buildCalibrationQuality({
        sampleCount: 10, baselineMetric: 0.001, noiseMetric: 0.0001,
        createdAtMs: NOW, lastValidatedAtMs: NOW - 1000, ttlMs: 30 * 60 * 1000
    }), /lastValidatedAtMs/);
});

test("MD-014: minimum sample floor enforced", () => {
    const cal = makeCalibration();
    for (let i = 0; i < CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES - 1; i++) cal.recordFrameEnergy(0.001);
    cal.finalizeBaseline();
    assert.equal(cal.state, CALIBRATION_STATE.UNCALIBRATED,
        "below minimum samples no baseline can be finalized");
});

// ---------------------------------------------------------------------------
// No raw data escape
// ---------------------------------------------------------------------------

test("MD-014: calibration surfaces only bounded metadata — no raw frames/energies", () => {
    const cal = makeCalibration();
    for (let i = 0; i < 30; i++) cal.recordFrameEnergy(0.001 + i * 1e-6);
    cal.finalizeBaseline();
    const meta = cal.observationMetadata();
    const flat = JSON.stringify(meta);
    for (const forbidden of ["Float32Array", "Float64Array", "amplitude", "frames", "buffer"]) {
        assert.equal(flat.includes(forbidden), false, `metadata must not contain ${forbidden}`);
    }
    const described = JSON.stringify(cal.describe());
    assert.equal(described.includes("Float32Array"), false);
    // describe() exposes sampleCount + metrics, never the sample arrays.
    assert.ok(described.includes("sampleCount"));
});

// ---------------------------------------------------------------------------
// Manager integration
// ---------------------------------------------------------------------------

function espCsiLine({ nsc = 52, seed = 1 } = {}) {
    const iq = [];
    for (let i = 0; i < nsc; i++) {
        iq.push(((i * 5 * seed) % 16) - 8, ((i * 3 * seed) % 16) - 8);
    }
    const dataField = '"[' + iq.join(",") + ']"';
    return `CSI_DATA,42,AA:BB:CC:DD:EE:FF,-55,72,0,6,1,0,0,0,0,0,0,-98,0,11,0,${12345678 + seed},0,0,0,${iq.length},0,${dataField}`;
}

test("MD-014: manager attaches bounded calibration metadata to observations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cal-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, Array.from({ length: 12 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW } });
    manager.addReplaySource({ id: "r1", sensorId: "sensor-a", filePath: file, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    const collected = [];
    await manager.loadReplay("r1", { onObservations: (obs) => collected.push(obs) });
    assert.ok(collected.length > 0);
    for (const obs of collected) {
        const cs = obs.attributes?.calibrationState;
        assert.ok(typeof cs === "string" && Object.values(CALIBRATION_STATE).includes(cs),
            `calibrationState must be a canonical lifecycle state, got ${cs}`);
        assert.ok(Number.isInteger(obs.attributes?.calibrationGeneration));
        // Replay calibration binding uses sourceKind replay — quality may be
        // present or null, but never fabricated.
        const q = obs.attributes?.calibrationQuality;
        if (q !== null && q !== undefined) {
            assert.ok(Number.isFinite(q.sampleCount) && q.sampleCount >= CALIBRATION_LIMITS.MIN_BASELINE_SAMPLES);
            assert.ok(Number.isFinite(q.baselineMetric));
        }
    }
    // Status exposes the calibration lifecycle (bounded).
    const status = manager.status();
    assert.equal(status.calibrations.length, 1);
    assert.equal(status.calibrations[0].binding.includes("replay"), true);
    assert.equal(status.calibrations[0].binding.includes("sensor-a"), true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("MD-014: explicit invalidation raises generation; new baseline is a new binding lifecycle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cal2-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, Array.from({ length: 12 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW } });
    manager.addReplaySource({ id: "r1", sensorId: "sensor-a", filePath: file, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    await manager.loadReplay("r1", { onObservations: () => {} });
    const gen1 = manager.status().calibrations[0].generation;
    const invalidated = manager.invalidateCalibration("r1", { reason: "sensor_reconnect" });
    assert.equal(invalidated.ok, true);
    assert.equal(invalidated.calibration.state, CALIBRATION_STATE.RECALIBRATION_REQUIRED);
    assert.equal(invalidated.calibration.generation, gen1 + 1);
    // Unknown source rejected.
    assert.equal(manager.invalidateCalibration("ghost").ok, false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("MD-014: replay NEVER receives a live trust seal even when calibrated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cal3-"));
    const file = path.join(dir, "ok.csi.csv");
    fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW } });
    manager.addReplaySource({ id: "r1", sensorId: "sensor-a", filePath: file, maxRateHz: 1000, location: { lat: -6.6, lon: 106.8 } });
    const collected = [];
    await manager.loadReplay("r1", { onObservations: (obs) => collected.push(obs) });
    const cal = manager.status().calibrations[0];
    assert.equal(cal.state, CALIBRATION_STATE.CALIBRATED, "replay reached CALIBRATED");
    for (const obs of collected) {
        assert.equal(isTrustedLiveRfObservation(obs), false,
            "CALIBRATED replay is still REPLAY — no live trust, ever");
    }
    fs.rmSync(dir, { recursive: true, force: true });
});
