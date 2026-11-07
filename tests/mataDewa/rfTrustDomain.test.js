"use strict";

/**
 * FOURTH NARROW REPAIR — adversarial matrix for MD-015/016/017.
 *
 * TRUST DOMAIN (A–G):
 *   A  forged caller-shaped seal        → NOT trusted
 *   B  direct RfManager (no canonical submit) → no canonical live evidence
 *   C  foreign trust domain             → FALSE
 *   D  JSON clone of trusted object     → NOT trusted
 *   E  public re-ingest of clone        → stored object NOT trusted
 *   F  canonical trusted ingest         → STORED canonical object trusted
 *      (MD-017 closure: the manager's pre-normalization object is NOT the
 *       trusted one; trust lands on the exact stored object)
 *   G  replay through canonical manager → never trusted-live
 *
 * WATCH GATE (1–15): positive requirements — absence IS rejection.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { MataDewaService } = require("../../src/mataDewa/service");
const { normalizeObservation, OBSERVATION_TYPE } = require("../../src/mataDewa/observations/observation");
const { createRfTrustDomain, rfSourceModeOf, BINDING_LIMITS } = require("../../src/mataDewa/rf/rfTrust");
const { RfManager } = require("../../src/mataDewa/rf/rfManager");
const { parseRuviewFrame, ADR018_MAGIC, ADR018_HEADER_SIZE, SOURCE_KIND } = require("../../src/mataDewa/rf/capture/sources");
const { evaluateRfPresenceRisk, productionLiveVerdict } = require("../../src/mataDewa/watch/rfPresence");
const { CALIBRATION_STATE } = require("../../src/mataDewa/rf/calibration");

const NOW = 1700000000000;

function makeService(options = {}) {
    return new MataDewaService({ clock: { nowMs: () => NOW }, ...options });
}

/** Canonical-looking frozen observation (the caller's best forgery). */
function canonicalRfObservation({ attrs = {}, observedAt = NOW - 500 } = {}) {
    return normalizeObservation({
        source: "mataDewa.rf:s1",
        type: OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE,
        location: { lat: -6.2, lon: 106.8 },
        observedAt,
        confidence: 0.9,
        epistemic: "INFERRED",
        attributes: {
            presence: true,
            sensorLat: -6.2, sensorLon: 106.8,
            sensorId: "s1", captureSession: "cs1", sourceKind: "udp", channel: 6,
            ...attrs
        },
        lineage: { kind: "sensor", providerFamily: "mata-dewa-rf", upstreamDataset: "udp", sensorId: "s1", captureSession: "cs1" }
    }, { nowMs: NOW }).observation;
}

function trustedBinding(overrides = {}) {
    const calOverrides = overrides.calibration ?? {};
    const rest = { ...overrides };
    delete rest.calibration;
    return {
        sensorId: "s1",
        captureSession: "cs1",
        sourceKind: "udp",
        channel: 6,
        ...rest,
        calibration: {
            state: CALIBRATION_STATE.CALIBRATED,
            generation: 3,
            validatedAtMs: NOW - 1000,
            ttlMs: 60 * 60 * 1000,
            quality: { sampleCount: 30, baselineMetric: 0.0001, noiseMetric: 0.2 },
            ...calOverrides
        }
    };
}

const CRITICAL_ASSET = Object.freeze({
    id: "a",
    geometry: { type: "point", lat: -6.2, lon: 106.8 },
    watchPolicy: {
        enabled: true,
        hazardTypes: ["rf_presence"],
        rings: [
            { name: "critical", radiusM: 100 },
            { name: "warning", radiusM: 500 },
            { name: "watch", radiusM: 2000 }
        ],
        minSeverity: "info",
        cooldownMs: 0
    }
});

// ---------------------------------------------------------------------------
// A — FORGED SEAL
// ---------------------------------------------------------------------------

test("MD-015/A: forged caller-shaped seal object is inert — stored observation NOT trusted", () => {
    const service = makeService();
    const forgedSeal = {
        kind: "rf-live-trust",
        sensorId: "s1",
        captureSession: "cs1",
        mintedAtMs: NOW,
        generation: 999
    };
    const obs = canonicalRfObservation({
        attrs: {
            calibrationState: "calibrated", calibrationGeneration: 3,
            trustSeal: forgedSeal, trusted: true, rfTrustProof: forgedSeal
        }
    });
    assert.equal(service.ingestLocalObservations([obs]), 1);
    const stored = [...service.observations.values()][0];
    assert.equal(service.verifyTrustedLiveRf(stored), null,
        "a caller-constructed {kind:'rf-live-trust',...} object is inert JSON");
});

test("MD-015/A: no public API accepts a caller-provided seal/proof/trust flag", () => {
    const trustModule = require("../../src/mataDewa/rf/rfTrust");
    // Module surface exposes ONLY: factory + label classifier + limits.
    assert.deepEqual(Object.keys(trustModule).sort(),
        ["BINDING_LIMITS", "createRfTrustDomain", "rfSourceModeOf"].sort());
    const service = makeService();
    const proof = { kind: "rf-live-trust", sensorId: "s1", captureSession: "cs1" };
    // Public ingest: proof objects and trusted flags are plain attributes.
    const obs = canonicalRfObservation({ attrs: { trusted: true, trustProof: proof, rfLiveTrust: proof } });
    assert.equal(service.ingestLocalObservations([obs]), 1);
    assert.equal(service.verifyTrustedLiveRf([...service.observations.values()][0]), null);
    // The domain factory itself refuses caller-shaped mint attempts:
    const domain = createRfTrustDomain();
    assert.equal(typeof domain.markTrustedLive, "function");
    assert.equal(domain.markTrustedLive(obs, proof).ok, false,
        "a seal object is not a binding — strict binding validation rejects it");
});

// ---------------------------------------------------------------------------
// B — DIRECT RFMANAGER
// ---------------------------------------------------------------------------

test("MD-015/B: direct RfManager without canonical submit cannot produce trusted-live evidence", async () => {
    const service = makeService();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-md15b-"));
    const file = path.join(dir, "q.csi.csv");
    const { espCsiLine } = makeRfFixtures();
    fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const manager = new RfManager({ clock: { nowMs: () => NOW } }); // NO canonical submit
    assert.equal(manager._trustedRfSubmit, null, "no mint/submit capability exists");
    manager.addReplaySource({ id: "r", sensorId: "s1", filePath: file, maxRateHz: 1000, location: { lat: -6.2, lon: 106.8 } });
    const produced = [];
    await manager.loadReplay("r", { onObservations: (o) => produced.push(o) });
    assert.ok(produced.length > 0);
    // Even re-ingested into a service, nothing the direct manager produced is trusted.
    assert.equal(service.ingestLocalObservations(produced), produced.length);
    for (const stored of service.observations.values()) {
        assert.equal(service.verifyTrustedLiveRf(stored), null);
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

test("MD-015/B: direct RfManager WITH a UDP source still cannot mint — frames produce zero trust", () => {
    const service = makeService();
    const manager = new RfManager({ clock: { nowMs: () => NOW }, allowLocalUdp: true });
    manager.addUdpSource({ id: "u", sensorId: "s1", bindPort: 0, location: { lat: -6.2, lon: 106.8 } });
    let obs = null;
    for (let i = 0; i < 45; i++) {
        obs = manager.processUdpFrame("u", buildRuviewFrame({ seq: i, jitterSeed: i }).frame) ?? obs;
    }
    assert.ok(obs, "direct manager still parses/processes (parsing is not trust)");
    assert.equal(service.ingestLocalObservations([obs]), 1);
    assert.equal(service.verifyTrustedLiveRf([...service.observations.values()][0]), null,
        "no canonical composition involvement → zero live trust");
});

// ---------------------------------------------------------------------------
// C — FOREIGN TRUST DOMAIN
// ---------------------------------------------------------------------------

test("MD-015/C: separately created trust domains never recognize each other", () => {
    const domainA = createRfTrustDomain();
    const domainB = createRfTrustDomain();
    const obs = canonicalRfObservation({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    const mark = domainA.markTrustedLive(obs, trustedBinding());
    assert.equal(mark.ok, true);
    assert.ok(domainA.verifyTrustedLive(obs), "domain A trusts its own mark");
    assert.equal(domainB.verifyTrustedLive(obs), null,
        "domain B does NOT recognize domain A's mark");
});

test("MD-015/C: two canonical compositions hold isolated trust domains", () => {
    const serviceA = makeService({ allowLocalUdp: true });
    const serviceB = makeService();
    const added = serviceA.rfManager.addUdpSource({ id: "u", sensorId: "s1", bindPort: 0, location: { lat: -6.2, lon: 106.8 } });
    assert.equal(added.ok, true);
    // Quiet frames → calibration CALIBRATED + observations submitted through
    // A's canonical composition.
    let produced = false;
    for (let i = 0; i < 45; i++) {
        if (serviceA.rfManager.processUdpFrame("u", buildRuviewFrame({ seq: i, jitterSeed: i }).frame)) produced = true;
    }
    assert.ok(produced, "A's manager produced observations");
    const cal = serviceA.rfManager._calibrations.get("u");
    assert.equal(cal.effectiveState(), CALIBRATION_STATE.CALIBRATED);
    const storedA = [...serviceA.observations.values()].pop();
    assert.ok(storedA, "evidence stored through A's canonical ingest");
    assert.ok(serviceA.verifyTrustedLiveRf(storedA), "A's domain trusts A's stored object");
    // B's canonical composition knows nothing about A's evidence.
    assert.equal(serviceB.verifyTrustedLiveRf(storedA), null,
        "composition B must never recognize composition A's live trust");
    assert.equal(serviceB.observations.size, 0, "evidence did not leak into B either");
});

// ---------------------------------------------------------------------------
// D / E — JSON CLONE + PUBLIC RE-INGEST
// ---------------------------------------------------------------------------

test("MD-015/D: JSON stringify/parse of a trusted stored object is NOT trusted", () => {
    const service = makeService();
    const obs = canonicalRfObservation({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    const domain = createRfTrustDomain();
    assert.equal(domain.markTrustedLive(obs, trustedBinding()).ok, true);
    const clone = JSON.parse(JSON.stringify(obs));
    assert.deepEqual(JSON.parse(JSON.stringify(clone)), JSON.parse(JSON.stringify(obs)),
        "clone carries identical JSON content");
    assert.equal(domain.verifyTrustedLive(clone), null,
        "identity-keyed domain: clone is a different object → untrusted");
});

test("MD-015/E: trusted object cloned and re-fed through public ingest is stored UNTRUSTED", () => {
    const service = makeService();
    const domain = createRfTrustDomain();
    const obs = canonicalRfObservation({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    assert.equal(domain.markTrustedLive(obs, trustedBinding()).ok, true);
    const clone = JSON.parse(JSON.stringify(obs));
    assert.equal(service.ingestLocalObservations([clone]), 1);
    const stored = [...service.observations.values()][0];
    assert.equal(service.verifyTrustedLiveRf(stored), null,
        "public re-ingest NEVER mints — even for a JSON-perfect clone of trusted evidence");
});

// ---------------------------------------------------------------------------
// F — CANONICAL TRUSTED INGEST (MD-017 closure)
// ---------------------------------------------------------------------------

test("MD-017/F: trust lands on the STORED canonical object — not the manager's pre-normalization object", () => {
    const service = makeService({ allowLocalUdp: true });
    const result = service.rfManager.addUdpSource({ id: "u", sensorId: "s1", bindPort: 0, location: { lat: -6.2, lon: 106.8 } });
    assert.equal(result.ok, true);
    let managerObject = null;
    for (let i = 0; i < 45; i++) {
        managerObject = service.rfManager.processUdpFrame("u", buildRuviewFrame({ seq: i, jitterSeed: i }).frame) ?? managerObject;
    }
    assert.ok(managerObject, "manager produced an observation object");
    const cal = service.rfManager._calibrations.get("u");
    assert.equal(cal.effectiveState(), CALIBRATION_STATE.CALIBRATED, "quiet frames reach CALIBRATED");
    // MD-017 directly: the manager's object is NOT the stored object.
    assert.equal(service.verifyTrustedLiveRf(managerObject), null,
        "trust does NOT transfer to the pre-normalization object");
    const stored = [...service.observations.values()].pop();
    assert.notEqual(stored, managerObject, "service re-normalization created a NEW object");
    assert.ok(service.verifyTrustedLiveRf(stored),
        "the STORED canonical object carries the internal trust metadata");
    const meta = service.verifyTrustedLiveRf(stored);
    assert.equal(meta.sensorId, "s1");
    assert.equal(meta.captureSession, stored.attributes.captureSession);
    assert.equal(meta.sourceKind, "udp");
    assert.equal(meta.calibrationState, "calibrated");
    assert.equal(meta.calibrationGeneration, stored.attributes.calibrationGeneration);
    assert.ok(meta.calibrationQuality.sampleCount >= 5);
});

test("MD-017/F: full wire path — real UDP loopback frames end as trusted stored canonical objects", async () => {
    // Real wall clock: the socket path stamps arrival time (Date.now());
    // a frozen test clock would make real arrivals "future" → rejected.
    const service = new MataDewaService({ allowLocalUdp: true });
    const added = service.rfManager.addUdpSource({
        id: "wire", sensorId: "esp32-wire", bindPort: 0,
        maxRateHz: 100000, location: { lat: -6.2, lon: 106.8 }
    });
    assert.equal(added.ok, true);
    const started = await service.rfManager.startUdp("wire");
    assert.equal(started.ok, true, `udp start: ${started.reason ?? "ok"}`);
    try {
        const port = service.rfManager.sources.get("wire")._socket.address().port;
        const client = dgram.createSocket("udp4");
        // 90 quiet frames → calibration CALIBRATED; 60 loud frames → presence.
        for (let i = 0; i < 150; i++) {
            const { raw } = buildRuviewFrame({ seq: i, subcarriers: 52, loud: i >= 90 });
            await new Promise((resolve) => client.send(raw, port, "127.0.0.1", resolve));
        }
        client.close();
        await new Promise((r) => setTimeout(r, 80));

        const status = service.rfManager.status();
        const cal = status.calibrations[0];
        assert.ok(cal, "calibration exists for the wire source");
        assert.equal(cal.state, CALIBRATION_STATE.CALIBRATED, `calibration state: ${cal.state}`);

        const nowMs = Date.now();
        const stored = [...service.observations.values()]
            .filter(o => o.attributes?.sourceKind === "udp")
            .filter(o => nowMs - o.observedAt < 30000)
            .sort((a, b) => a.observedAt - b.observedAt);
        assert.ok(stored.length > 20, `stored udp observations: ${stored.length}`);
        const trustedLate = stored.filter(o => service.verifyTrustedLiveRf(o) !== null);
        assert.ok(trustedLate.length > 0, "wire-path observations are trusted on the stored object");
        const meta = service.verifyTrustedLiveRf(trustedLate[trustedLate.length - 1]);
        assert.equal(meta.sensorId, "esp32-wire");
        assert.equal(meta.sourceKind, "udp");
        assert.equal(meta.calibrationState, CALIBRATION_STATE.CALIBRATED);
    }
    finally {
        service.rfManager.stop();
        await new Promise((r) => setTimeout(r, 20));
    }
});

// ---------------------------------------------------------------------------
// G — REPLAY REMAINS NON-PRODUCTION
// ---------------------------------------------------------------------------

test("MD-015/G: replay through the CANONICAL manager is never trusted-live", async () => {
    const service = makeService();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-md15g-"));
    const file = path.join(dir, "r.csi.csv");
    const { espCsiLine } = makeRfFixtures();
    fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => espCsiLine({ seed: i + 1 })).join("\n") + "\n");
    const added = service.rfManager.addReplaySource({
        id: "rep", sensorId: "s1", filePath: file, maxRateHz: 1000, location: { lat: -6.2, lon: 106.8 }
    });
    assert.equal(added.ok, true);
    const produced = [];
    await service.rfManager.loadReplay("rep", { onObservations: (o) => produced.push(o) });
    assert.ok(produced.length > 0);
    const stored = [...service.observations.values()];
    assert.ok(stored.length > 0, "replay evidence is stored (visible, coarse)");
    for (const o of stored) {
        assert.equal(service.verifyTrustedLiveRf(o), null,
            "replay can NEVER receive the canonical live mint");
        assert.equal(rfSourceModeOf(o), "REPLAY");
    }
    // Enforcement lives at the AUTHORITY (the mint), not the producer: the
    // manager submitted replay evidence, the domain refused every mark.
    const diag = service.rfTrustStatus();
    assert.ok(diag.mintRejected > 0, `mint rejected replay marks: ${JSON.stringify(diag)}`);
    // Even a hand-crafted CALIBRATED replay binding is refused at the mint.
    const domain = createRfTrustDomain();
    const reject = domain.markTrustedLive(stored[0], trustedBinding({
        sensorId: "s1", captureSession: stored[0].attributes.captureSession, sourceKind: "replay"
    }));
    assert.equal(reject.ok, false, "sourceKind replay is refused at the mint itself");
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MINT-LEVEL FAIL-CLOSED (supporting proofs)
// ---------------------------------------------------------------------------

test("MD-015: mint refuses unfrozen objects, replay kinds, and non-CALIBRATED states", () => {
    const domain = createRfTrustDomain();
    const unfrozen = { id: "x", attributes: {} };
    assert.equal(domain.markTrustedLive(unfrozen, trustedBinding()).ok, false,
        "only canonical frozen objects can be marked");
    const frozen = canonicalRfObservation({ attrs: { calibrationState: "calibrated", calibrationGeneration: 3 } });
    for (const state of [CALIBRATION_STATE.COLLECTING, CALIBRATION_STATE.STALE,
        CALIBRATION_STATE.NOISY, CALIBRATION_STATE.INVALID, CALIBRATION_STATE.RECALIBRATION_REQUIRED]) {
        const verdict = domain.markTrustedLive(frozen, trustedBinding({ calibration: { state } }));
        assert.equal(verdict.ok, false, `state ${state} must never mint live trust`);
    }
    for (const kind of ["replay", "simulated", "REPLAY"]) {
        const verdict = domain.markTrustedLive(frozen, trustedBinding({ sourceKind: kind }));
        assert.equal(verdict.ok, false, `sourceKind ${kind} must never mint`);
    }
    const diag = domain.diagnostics();
    assert.ok(diag.mintRejected >= 8, "rejections are counted (bounded diagnostics)");
});

// ---------------------------------------------------------------------------
// WATCH GATE 1–15 — positive requirements; absence IS rejection
// ---------------------------------------------------------------------------

/** Build (obs, domain) where obs is marked trusted-live with `binding`. */
function gateCase({ attrs, binding = trustedBinding(), mark = true } = {}) {
    const domain = createRfTrustDomain();
    const obs = canonicalRfObservation({ attrs });
    if (mark) {
        const verdict = domain.markTrustedLive(obs, binding);
        assert.equal(verdict.ok, true, `gate fixture must mark: ${verdict.reason ?? "ok"}`);
    }
    return { obs, domain };
}

function assertNoProductionAlert({ obs, domain }, label) {
    const evaluation = evaluateRfPresenceRisk(CRITICAL_ASSET, [obs], {
        nowMs: NOW, windowMs: 30000, verifyTrustedLive: domain.verifyTrustedLive
    });
    assert.ok(evaluation, `${label}: evidence is still visible`);
    assert.notEqual(evaluation.riskState, "critical", label);
    assert.notEqual(evaluation.riskState, "warning", label);
    assert.equal(evaluation.riskState, "watch", label);
    assert.equal(evaluation.productionAlert, false, label);
    assert.equal(evaluation.severity, "watch", label);
    return evaluation;
}

test("MD-016/1: trusted live + missing calibrationState → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationGeneration: 3 } }), "missing calibrationState");
});

test("MD-016/2: trusted live + COLLECTING → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "collecting", calibrationGeneration: 3 } }), "COLLECTING");
});

test("MD-016/3: trusted live + STALE → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "stale", calibrationGeneration: 3 } }), "STALE");
});

test("MD-016/4: trusted live + NOISY → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "noisy", calibrationGeneration: 3 } }), "NOISY");
});

test("MD-016/5: trusted live + INVALID → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "invalid", calibrationGeneration: 3 } }), "INVALID");
});

test("MD-016/6: trusted live + RECALIBRATION_REQUIRED → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "recalibration_required", calibrationGeneration: 3 } }), "RECAL");
});

test("MD-016/7: trusted live + CALIBRATED but missing generation → NO production alert", () => {
    assertNoProductionAlert(gateCase({ attrs: { calibrationState: "calibrated" } }), "missing generation");
});

test("MD-016/8: trusted live + generation mismatch → NO production alert", () => {
    assertNoProductionAlert(gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 99 }
    }), "generation mismatch");
});

test("MD-016/9: trusted live + session mismatch → NO production alert", () => {
    assertNoProductionAlert(gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3, captureSession: "cs-forged" }
    }), "session mismatch");
});

test("MD-016/10: trusted live + sensor mismatch → NO production alert", () => {
    assertNoProductionAlert(gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3, sensorId: "s-forged" }
    }), "sensor mismatch");
});

test("MD-016/11: trusted live + source mismatch → NO production alert", () => {
    assertNoProductionAlert(gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3, sourceKind: "wifi" }
    }), "source mismatch");
});

test("MD-016/12: trusted live + expired calibration → NO production alert", () => {
    assertNoProductionAlert(gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 },
        binding: trustedBinding({ calibration: { validatedAtMs: NOW - 2 * 60 * 60 * 1000, ttlMs: 60 * 60 * 1000 } })
    }), "expired calibration");
});

test("MD-016/13: trusted live + NaN quality → NO production alert (mint refuses NaN)", () => {
    const domain = createRfTrustDomain();
    const obs = canonicalRfObservation({ attrs: { calibrationState: "calibrated", calibrationGeneration: 3 } });
    const verdict = domain.markTrustedLive(obs, trustedBinding({
        calibration: { quality: { sampleCount: 30, baselineMetric: NaN, noiseMetric: 0.2 } }
    }));
    assert.equal(verdict.ok, false, "NaN never passes the mint");
    const evaluation = evaluateRfPresenceRisk(CRITICAL_ASSET, [obs], {
        nowMs: NOW, windowMs: 30000, verifyTrustedLive: domain.verifyTrustedLive
    });
    assert.equal(evaluation.productionAlert, false);
    assert.equal(evaluation.riskState, "watch");
});

test("MD-016/14: untrusted + forged CALIBRATED metadata → NO production alert", () => {
    // Perfect forged declaration, NO canonical mark (public-ingest style).
    const { obs, domain } = gateCase({
        attrs: {
            calibrationState: "calibrated", calibrationGeneration: 3,
            sourceMode: "LIVE", simulated: false, trusted: true
        },
        mark: false
    });
    assert.equal(rfSourceModeOf(obs), "LIVE", "forged lineage still classifies as LIVE label");
    assertNoProductionAlert({ obs, domain }, "forged metadata without mark");
});

test("MD-016/15: valid trusted live + valid current CALIBRATED state → production risk evaluation MAY proceed", () => {
    const { obs, domain } = gateCase({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    const meta = domain.verifyTrustedLive(obs);
    assert.ok(meta, "fixture is genuinely trusted");
    const verdict = productionLiveVerdict(obs, domain.verifyTrustedLive, NOW, 30000);
    assert.ok(verdict, "full positive verdict passes");
    const evaluation = evaluateRfPresenceRisk(CRITICAL_ASSET, [obs], {
        nowMs: NOW, windowMs: 30000, verifyTrustedLive: domain.verifyTrustedLive
    });
    assert.ok(evaluation);
    assert.equal(evaluation.riskState, "critical", "gate is NOT permanently disabled");
    assert.equal(evaluation.productionAlert, true);
    assert.equal(evaluation.severity, "critical");
});

test("MD-016: no verifier at all → never production (engine composition fail-closed)", () => {
    const obs = canonicalRfObservation({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    const evaluation = evaluateRfPresenceRisk(CRITICAL_ASSET, [obs], { nowMs: NOW, windowMs: 30000 });
    assert.equal(evaluation.productionAlert, false);
    assert.equal(evaluation.riskState, "watch");
});

test("MD-016: watch engine without verifier keeps RF at watch severity end-to-end", async () => {
    const service = makeService();
    // Engine has no verifier until composition attaches one — simulate a
    // bare engine by detaching (prove the default is fail-closed).
    const saved = service.watchEngine.verifyTrustedLive;
    service.watchEngine.verifyTrustedLive = null;
    const obs = canonicalRfObservation({
        attrs: { calibrationState: "calibrated", calibrationGeneration: 3 }
    });
    service.ingestLocalObservations([obs]);
    await service.assetRegistry.upsert({
        id: "a", type: "building",
        geometry: { type: "point", lat: -6.2, lon: 106.8 },
        watchPolicy: CRITICAL_ASSET.watchPolicy
    });
    const tick = await service.runWatchOnce();
    assert.ok(tick);
    const events = service.watchEngine.listActiveEvents();
    for (const event of events) {
        assert.notEqual(event.severity, "critical", "no verifier → no production critical");
    }
    service.watchEngine.verifyTrustedLive = saved;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** RuView ADR-018 binary frame builder (header + 1 antenna I/Q).
 *  Quiet pattern: amplitudes in {-1,0,1} (low variance). Loud pattern:
 *  amplitudes 6..28 (high variance → presence). */
function buildRuviewFrame({ seq = 0, subcarriers = 52, loud = false } = {}) {
    const header = Buffer.alloc(ADR018_HEADER_SIZE);
    header.writeUInt32LE(ADR018_MAGIC, 0);
    header.writeUInt8(1, 4);              // node id
    header.writeUInt8(1, 5);              // antennas
    header.writeUInt16LE(subcarriers, 6);
    header.writeUInt32LE(2437, 8);        // freq MHz → channel 6
    header.writeUInt32LE(seq, 12);
    header.writeInt8(-55, 16);            // rssi
    header.writeInt8(-98, 17);            // noise floor
    const iq = Buffer.alloc(subcarriers * 2);
    for (let sc = 0; sc < subcarriers; sc++) {
        const v = loud ? 6 + ((sc * 7 + seq) % 23) : ((sc + seq) % 3) - 1;
        iq.writeInt8(v, sc * 2);
        iq.writeInt8(0, sc * 2 + 1);
    }
    const raw = Buffer.concat([header, iq]);
    const parsed = parseRuviewFrame(raw);
    assert.equal(parsed.ok, true, `fixture frame must parse: ${parsed.reason ?? "ok"}`);
    return { raw, frame: parsed.frame };
}

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
