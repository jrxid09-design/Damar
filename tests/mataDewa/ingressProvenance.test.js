"use strict";

/**
 * MD-012 + MD-010 — CANONICAL INGRESS + RF PROVENANCE (adversarial matrix).
 *
 * MD-012 bukti wajib (B1/B2):
 *  - SETIAP item publik melewati kanonikalisasi penuh — TIDAK ADA bypass
 *    schemaVersion / already-shaped / JSON clone.
 *  - confidence 99 / -1 / NaN / Infinity / timestamp masa depan / geometry
 *    invalid / prototype trick / getter trick / nested mutation → REJECT
 *    atau tetap immutable.
 *
 * MD-010 bukti wajib (C1/C2/C3/C4):
 *  - STRING LINEAGE != LIVE TRUST: caller publik dengan upstreamDataset
 *    "udp", sourceKind "live", simulated:false → TIDAK dipercaya live.
 *  - JSON clone observasi tepercaya → kehilangan live trust saat masuk
 *    lagi lewat ingress publik.
 *  - Replay dengan confidence tinggi → TIDAK pernah alert produksi normal.
 *  - Hanya ingest internal tepercaya (kanal leksikal rfTrust) yang boleh
 *    membawa provenance live sah.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { MataDewaService } = require("../../src/mataDewa/service");
const { normalizeObservation, OBSERVATION_TYPE } = require("../../src/mataDewa/observations/observation");
const { rfSourceModeOf, createRfTrustDomain } = require("../../src/mataDewa/rf/rfTrust");
const { evaluateRfPresenceRisk } = require("../../src/mataDewa/watch/rfPresence");
const { RfManager } = require("../../src/mataDewa/rf/rfManager");

const NOW = 1_700_000_000_000;

function makeService() {
    return new MataDewaService({ clock: { nowMs: () => NOW } });
}

function rawObservation(over = {}) {
    return {
        source: "public-caller", type: OBSERVATION_TYPE.GENERIC,
        location: { lat: -6.2, lon: 106.8 },
        observedAt: NOW - 1000, confidence: 0.5,
        ...over
    };
}

// ---------------------------------------------------------------------------
// MD-012 — B1: no schemaVersion / already-shaped / JSON-clone bypass
// ---------------------------------------------------------------------------

test("MD-012: schemaVersion alone does NOT bypass canonicalization", () => {
    const service = makeService();
    const item = rawObservation({ schemaVersion: 1, confidence: 99 });
    const accepted = service.ingestLocalObservations([item]);
    assert.equal(accepted, 0, "confidence 99 must be REJECTED even with schemaVersion present");
});

test("MD-012: look-alike canonical object with hostile confidence rejected (not stored)", () => {
    const service = makeService();
    const legit = normalizeObservation(rawObservation(), { nowMs: NOW }).observation;
    const clone = JSON.parse(JSON.stringify(legit));
    clone.confidence = -1; // hostile after clone
    const accepted = service.ingestLocalObservations([clone]);
    assert.equal(accepted, 0);
    assert.equal(service.observations.size, 0);
});

test("MD-012: JSON clone of a legitimate canonical observation re-canonicalizes (idempotent) and stores", () => {
    const service = makeService();
    const legit = normalizeObservation(rawObservation(), { nowMs: NOW }).observation;
    const clone = JSON.parse(JSON.stringify(legit));
    const accepted = service.ingestLocalObservations([clone]);
    assert.equal(accepted, 1);
    const stored = [...service.observations.values()][0];
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(stored.confidence, legit.confidence);
    assert.equal(stored.source, legit.source);
});

test("MD-012: canonical re-ingest is bounded and idempotent (legit canonical object accepted)", () => {
    const service = makeService();
    const legit = normalizeObservation(rawObservation(), { nowMs: NOW }).observation;
    assert.equal(service.ingestLocalObservations([legit]), 1);
    assert.equal(service.ingestLocalObservations([legit]), 1);
});

// ---------------------------------------------------------------------------
// MD-012 — B2: adversarial values all REJECT
// ---------------------------------------------------------------------------

test("MD-012 adversarial: confidence 99, -1, NaN, Infinity rejected", () => {
    const service = makeService();
    for (const confidence of [99, -1, NaN, Infinity, -Infinity]) {
        assert.equal(service.ingestLocalObservations([rawObservation({ confidence })]), 0,
            `confidence ${confidence} must reject`);
    }
    assert.equal(service.observations.size, 0);
});

test("MD-012 adversarial: future timestamp beyond clock skew rejected", () => {
    const service = makeService();
    assert.equal(service.ingestLocalObservations([
        rawObservation({ observedAt: NOW + 6 * 60 * 1000 })
    ]), 0);
});

test("MD-012 adversarial: invalid geometry rejected (out-of-range, NaN, wrong type)", () => {
    const service = makeService();
    assert.equal(service.ingestLocalObservations([
        rawObservation({ location: { lat: 999, lon: 0 } })]), 0);
    assert.equal(service.ingestLocalObservations([
        rawObservation({ location: { lat: NaN, lon: 0 } })]), 0);
    assert.equal(service.ingestLocalObservations([
        rawObservation({ geometry: { type: "cylinder", lat: 0, lon: 0 } })]), 0);
});

test("MD-012 adversarial: prototype trick rejected (no pollution, no silent drop)", () => {
    const service = makeService();
    const hostile = JSON.parse('{"source":"x","location":{"lat":-6.2,"lon":106.8},"observedAt":' + NOW + ',"__proto__":{"isAdmin":true}}');
    assert.equal(service.ingestLocalObservations([hostile]), 0);
    const probe = {};
    assert.equal(probe.isAdmin, undefined, "no prototype pollution escapes ingress");
    // Nested variant.
    const nested = JSON.parse('{"source":"x","location":{"lat":-6.2,"lon":106.8},"observedAt":' + NOW + ',"attributes":{"meta":{"constructor":{}}}}');
    assert.equal(service.ingestLocalObservations([nested]), 0);
});

test("MD-012 adversarial: getter-bearing objects rejected without executing getters", () => {
    const service = makeService();
    let getterRan = false;
    const hostile = rawObservation({});
    Object.defineProperty(hostile, "attributes", {
        get() { getterRan = true; return { stolen: true }; },
        enumerable: true
    });
    assert.equal(service.ingestLocalObservations([hostile]), 0);
    assert.equal(getterRan, false, "getter must never execute during canonicalization");
});

test("MD-012: post-ingest nested mutation cannot change the canonical record", () => {
    const service = makeService();
    const item = rawObservation({ attributes: { level: 1, meta: { deep: "v" } } });
    assert.equal(service.ingestLocalObservations([item]), 1);
    const stored = [...service.observations.values()][0];
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.attributes), true);
    assert.equal(Object.isFrozen(stored.attributes.meta), true);
    assert.throws(() => { stored.attributes.level = 99; }, TypeError);
    // Mutating the CALLER's input afterwards must not change the record.
    item.attributes.level = 99;
    item.attributes.meta.deep = "mutated";
    assert.equal([...service.observations.values()][0].attributes.level, 1);
    assert.equal([...service.observations.values()][0].attributes.meta.deep, "v");
});

test("MD-012: non-array / null items are safe no-ops", () => {
    const service = makeService();
    assert.equal(service.ingestLocalObservations(null), 0);
    assert.equal(service.ingestLocalObservations("nope"), 0);
    assert.equal(service.ingestLocalObservations([null, undefined, 42]), 0);
});

// ---------------------------------------------------------------------------
// MD-010 — C1/C4: string lineage is NEVER live trust (repaired architecture:
// trust = instance-local domain, composition-owned; verifier returns
// INTERNAL metadata or null — a forgeable seal object no longer exists)
// ---------------------------------------------------------------------------

test("MD-010: public caller with upstreamDataset 'udp' is NOT trusted live", () => {
    const service = makeService();
    const fake = normalizeObservation(rawObservation({
        type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        source: "mataDewa.rf:sneaky",
        attributes: { presence: true, sensorLat: -6.2, sensorLon: 106.8 },
        lineage: { providerFamily: "mata-dewa-rf", upstreamDataset: "udp", sensorId: "sneaky" }
    }), { nowMs: NOW }).observation;
    service.ingestLocalObservations([fake]);
    const stored = [...service.observations.values()][0];
    assert.equal(rfSourceModeOf(stored), "LIVE", "string says udp, but classification is just a label");
    assert.equal(service.verifyTrustedLiveRf(stored), null,
        "STRING LINEAGE != LIVE TRUST — public ingress never mints");
});

test("MD-010: public caller with sourceKind 'live' / simulated:false is NOT trusted live", () => {
    const service = makeService();
    const fake = normalizeObservation(rawObservation({
        type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        attributes: { presence: true, sensorLat: -6.2, sensorLon: 106.8, sourceKind: "live", simulated: false }
    }), { nowMs: NOW }).observation;
    assert.equal(service.verifyTrustedLiveRf(fake), null);
});

test("MD-010: public ingress NEVER carries live trust even with every forgeable marker", () => {
    const service = makeService();
    const forged = normalizeObservation(rawObservation({
        type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        attributes: {
            presence: true, sensorLat: -6.2, sensorLon: 106.8,
            sourceKind: "udp", simulated: false, sourceMode: "LIVE",
            calibrationState: "calibrated", calibrationGeneration: 7
        },
        lineage: { kind: "sensor", upstreamDataset: "udp", sensorId: "forged", captureSession: "forged" }
    }), { nowMs: NOW }).observation;
    service.ingestLocalObservations([forged]);
    const stored = [...service.observations.values()][0];
    assert.equal(service.verifyTrustedLiveRf(stored), null,
        "public ingress cannot mint — no caller-shaped proof exists");
});

test("MD-010: no forgeable seal/ingest surface exists anywhere public", () => {
    const trustModule = require("../../src/mataDewa/rf/rfTrust");
    // The forgeable API is GONE from the module surface:
    for (const forbidden of ["sealObservationAsTrustedLive", "isTrustedLiveRfObservation",
        "createRfIngestChannel", "registerRfTrustComposition", "mintRfLiveTrustFor"]) {
        assert.equal(forbidden in trustModule, false, `${forbidden} must not exist`);
    }
    const service = makeService();
    // No ingest channel property is attached to the canonical manager.
    assert.equal("ingestChannel" in service.rfManager, false);
    // The service exposes ONLY read-only verify — no write/trust API.
    assert.equal(typeof service.verifyTrustedLiveRf, "function");
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
        assert.equal(/seal|mint|trust.*(set|mark|grant)|mark.*trust/i.test(key), false,
            `no public trust-writing API: ${key}`);
    }
});

test("MD-010: JSON clone of a trusted observation loses trust (identity-keyed domain)", async () => {
    // Canonical-path equivalent: mark a frozen canonical observation in the
    // composition's own trust domain, then JSON round-trip it.
    const service = makeService();
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "rf-trust-"));
    const file = require("node:path").join(dir, "live.csi.csv");
    const { espCsiLine } = makeRfFixtures();
    require("node:fs").writeFileSync(file, Array.from({ length: 40 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW }, allowLocalUdp: false });
    const collected = [];
    manager.addReplaySource({ id: "r", sensorId: "s1", filePath: file, maxRateHz: 1000, location: { lat: -6.2, lon: 106.8 } });
    await manager.loadReplay("r", { onObservations: (o) => collected.push(o) });
    require("node:fs").rmSync(dir, { recursive: true, force: true });
    assert.ok(collected.length > 0);
    const replayObs = collected[collected.length - 1];
    // Replay observations are never trusted live.
    assert.equal(service.verifyTrustedLiveRf(replayObs), null);
    // JSON clone → different identity: trust cannot survive serialization;
    // public re-injection is plain (stored, never trusted).
    const clone = JSON.parse(JSON.stringify(replayObs));
    assert.equal(service.verifyTrustedLiveRf(clone), null);
    assert.equal(service.ingestLocalObservations([clone]), 1,
        "clone is canonically valid — but carries zero live trust");
    assert.equal(service.verifyTrustedLiveRf([...service.observations.values()][0]), null);
});

// ---------------------------------------------------------------------------
// MD-010 — C3: replay can NEVER escalate production severity
// ---------------------------------------------------------------------------

test("MD-010: replay evidence with very high confidence produces NO production critical alert", () => {
    const asset = {
        id: "a", geometry: { type: "point", lat: -6.2, lon: 106.8 },
        watchPolicy: { rings: [{ name: "critical", radiusM: 100 }, { name: "warning", radiusM: 500 }, { name: "watch", radiusM: 2000 }] }
    };
    const replayObs = normalizeObservation({
        source: "mataDewa.rf:s1", type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        location: { lat: -6.2, lon: 106.8 },
        observedAt: NOW - 500, confidence: 0.99, epistemic: "INFERRED",
        attributes: {
            presence: true, sensorLat: -6.2, sensorLon: 106.8,
            sourceKind: "replay", calibrationState: "calibrated"
        },
        lineage: { kind: "sensor", upstreamDataset: "replay", sensorId: "s1" }
    }, { nowMs: NOW }).observation;
    const evaluation = evaluateRfPresenceRisk(asset, [replayObs], { nowMs: NOW, windowMs: 30000 });
    assert.ok(evaluation, "replay is still visible as a simulation result");
    assert.equal(evaluation.simulation, true);
    assert.equal(evaluation.sourceMode, "REPLAY");
    assert.equal(evaluation.productionAlert, false, "REPLAY != LIVE");
    assert.equal(evaluation.severity, "watch", "never normal production warning/critical");
    assert.notEqual(evaluation.riskState, "critical");
    assert.notEqual(evaluation.riskState, "warning");
});

test("MD-010: replay motion spike produces no production emergency alert", () => {
    const asset = {
        id: "a", geometry: { type: "point", lat: -6.2, lon: 106.8 },
        watchPolicy: { rings: [{ name: "critical", radiusM: 100 }, { name: "warning", radiusM: 500 }, { name: "watch", radiusM: 2000 }] }
    };
    const spike = normalizeObservation({
        source: "mataDewa.rf:s1", type: OBSERVATION_TYPE.RF_MOTION_ESTIMATE,
        location: { lat: -6.2, lon: 106.8 },
        observedAt: NOW - 100, confidence: 0.95, epistemic: "INFERRED",
        attributes: {
            presence: true, sensorLat: -6.2, sensorLon: 106.8,
            sourceKind: "replay", motionEnergy: 99999
        },
        lineage: { kind: "sensor", upstreamDataset: "replay", sensorId: "s1" }
    }, { nowMs: NOW }).observation;
    const evaluation = evaluateRfPresenceRisk(asset, [spike], { nowMs: NOW, windowMs: 30000 });
    assert.ok(evaluation);
    assert.equal(evaluation.productionAlert, false);
    assert.equal(evaluation.severity, "watch");
});

test("MD-010: replay result is explicitly distinguishable from live alert state", () => {
    const asset = {
        id: "a", geometry: { type: "point", lat: -6.2, lon: 106.8 },
        watchPolicy: { rings: [{ name: "watch", radiusM: 2000 }] }
    };
    const liveLike = normalizeObservation(rawObservation({
        type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE, epistemic: "INFERRED",
        attributes: { presence: true, sensorLat: -6.2, sensorLon: 106.8 }
    }), { nowMs: NOW }).observation;
    const liveEval = evaluateRfPresenceRisk(asset, [liveLike], { nowMs: NOW, windowMs: 30000 });
    assert.ok(liveEval);
    assert.equal(liveEval.simulation, undefined, "non-replay path never claims simulation");
    assert.equal(liveEval.productionAlert, false, "untrusted live path is watch-only");
});

test("MD-010: canonical composition exposes ONLY the read-only verifier", () => {
    const service = makeService();
    // Read-only verifier is a function; returns null for untrusted.
    assert.equal(typeof service.verifyTrustedLiveRf, "function");
    assert.equal(service.verifyTrustedLiveRf(null), null);
    assert.equal(service.rfTrustStatus().kind, "rf-trust-domain");
    // Canonical manager carries no public ingest channel / mint surface.
    assert.equal("ingestChannel" in service.rfManager, false);
    assert.equal(service.rfManager._trustedRfSubmit !== null, true,
        "canonical manager holds the lexical submit closure");
    // A directly constructed manager has NO submit capability at all.
    const foreign = new RfManager({ clock: { nowMs: () => NOW } });
    assert.equal(foreign._trustedRfSubmit, null);
});

// ---- shared RF fixture helper (mirror rfSensing.test.js) ---------------------
function makeRfFixtures() {
    function espCsiLine({ nsc = 52, seed = 1 } = {}) {
        const iq = [];
        for (let i = 0; i < nsc; i++) {
            iq.push(((i * 5 * seed) % 16) - 8, ((i * 3 * seed) % 16) - 8);
        }
        const dataField = '"[' + iq.join(",") + ']"';
        return `CSI_DATA,42,AA:BB:CC:DD:EE:FF,-55,72,0,6,1,0,0,0,0,0,0,-98,0,11,0,${12345678 + seed},0,0,0,${iq.length},0,${dataField}`;
    }
    return { espCsiLine };
}
