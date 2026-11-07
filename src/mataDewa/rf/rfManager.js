"use strict";

/**
 * RfManager — memegang sumber RF + sesi pemrosesan + integrasi observasi.
 *
 * HUKUM:
 *  - Sumber DAN sesi hanya dibuat lewat trusted composition
 *    (buildRfManager). Tidak ada penemuan sumber otomatis; UDP wajib
 *    allowLocalUdp eksplisit (fail-closed pra-Lane4, lihat sources.js).
 *  - Setiap sesi menghasilkan SpatialObservation TIPIKAL di sini —
 *    rf.motion_estimate / rf.presence_estimate — lewat
 *    normalizeObservation (skema ketat) dengan lineage:
 *    sensorId + captureSession → satu independenceGroup.
 *  - Estimasi yang gagal ketat (confidence/bounds) DITOLAK, bukan
 *    dipaksa; tidak ada klaim tanpa bukti.
 *  - Manager sendiri bukan otoritas; observasi masuk ke pipeline Mata
 *    Dewa yang sama (service.ingestObservations).
 */

const { ReplayRfSource, UdpRfSource, parseRuviewFrame, CsiRingBuffer, SOURCE_KIND } = require("./capture/sources");
const { RfProcessingSession } = require("./processing");
const { normalizeObservation, OBSERVATION_TYPE } = require("../observations/observation");
const { LINEAGE_KIND } = require("../spatial/lineage");
const { isValidPoint } = require("../spatial/geo");
const { RfCalibration, CALIBRATION_STATE } = require("./calibration");

const RF_UNITS = Object.freeze({
    MOTION_ENERGY: "motion_energy_variance",
    PRESENCE: "boolean"
});

class RfManager {

    /**
     * @param {{
     *   clock?: { nowMs(): number },
     *   allowLocalUdp?: boolean,
     *   trustedRfSubmit?: null | ((observation: object, binding: object) => object)
     * }} options
     *
     * MD-015/1E: `trustedRfSubmit` HANYA diberikan oleh komposisi kanonik
     * (MataDewaService). RfManager yang dibuat langsung TIDAK punya
     * kemampuan ini → ia boleh memparsing/memproses/menguji, tetapi TIDAK
     * PERNAH dapat menciptakan bukti live produksi kanonik (fail closed).
     * Callback dilewatkan sebagai closure — TIDAK dijadikan properti publik,
     * TIDAK diekspor lewat status()/describe().
     */
    constructor({ clock = { nowMs: () => Date.now() }, allowLocalUdp = false, trustedRfSubmit = null } = {}) {
        this.clock = clock;
        this.allowLocalUdp = allowLocalUdp === true;
        // MD-015: kemampuan submit live HANYA lewat callback leksikal dari
        // komposisi kanonik. Bukan mint di manager — manager TIDAK PERNAH
        // memegang kemampuan menandai; ia hanya mengirimkan bukti + binding,
        // dan domain kanonik yang memutuskan (validasi + mark + store).
        this._trustedRfSubmit = typeof trustedRfSubmit === "function" ? trustedRfSubmit : null;
        /** @type {Map<string, RfSource>} */
        this.sources = new Map();
        /** @type {Map<string, RfProcessingSession>} */
        this.sessions = new Map();
        /** @type {Map<string, {lat:number,lon:number}>} lokasi sensor */
        this._sourceLocations = new Map();
        /** @type {Map<string, RfCalibration>} kalibrasi per sumber (MD-014) */
        this._calibrations = new Map();
        /** @type {CsiRingBuffer} */
        this.frameHistory = new CsiRingBuffer();
        this.observationsProduced = 0;
        this.observationsRejected = 0;
        this.lastSourceStatuses = [];
    }

    /**
     * Tambah sumber REPLAY (file lokal, offline-safe). Trusted composition.
     * @returns {{ ok:true, source } | { ok:false, reason }}
     */
    addReplaySource({ id, sensorId, filePath, format = null, maxRateHz, location = null } = {}) {
        if (!id || this.sources.has(id)) return { ok: false, reason: `sumber '${id}' tidak valid/duplikat` };
        // Lokasi sensor WAJIB: observasi RF tanpa lokasi tidak dapat
        // ditindaklanjuti dalam sistem spasial (dan watch menuntut geo).
        if (!location || !isValidPoint(location)) {
            return { ok: false, reason: "sumber RF butuh location {lat,lon} sensor yang valid" };
        }
        const source = new ReplayRfSource({ id, sensorId, filePath, format, maxRateHz, clock: this.clock });
        this._sourceLocations.set(id, location);
        this.sources.set(id, source);
        return { ok: true, source };
    }

    /**
     * Tambah sumber UDP (ADR-018) — HANYA dengan allowLocalUdp dari
     * trusted composition; bind loopback. Frame yang masuk diproses ke
     * sesi + observasi via onFrame bawaan source.
     */
    addUdpSource({ id, sensorId, bindAddress = "127.0.0.1", bindPort = 0, maxRateHz, location = null } = {}) {
        if (!this.allowLocalUdp) {
            return { ok: false, reason: "AUTHORIZED_LOCAL_SOURCE ditolak: allowLocalUdp=false (fail-closed pra-Lane4)" };
        }
        if (!id || this.sources.has(id)) return { ok: false, reason: `sumber '${id}' tidak valid/duplikat` };
        // Lokasi sensor WAJIB (sistem spasial; watch menuntut geo).
        if (!location || !isValidPoint(location)) {
            return { ok: false, reason: "sumber RF butuh location {lat,lon} sensor yang valid" };
        }
        const source = new UdpRfSource({
            id, sensorId, bindAddress, bindPort, maxRateHz, allowLocalUdp: true,
            onFrame: (frame) => this.processUdpFrame(id, frame)
        });
        this._sourceLocations.set(id, location);
        this.sources.set(id, source);
        return { ok: true, source };
    }

    /**
     * Muat sumber replay; onObservations menerima observasi RF.
     * @returns {Promise<{ok:boolean, framesAccepted:number, framesDropped:number}>}
     */
    async loadReplay(sourceId, { onObservations = null } = {}) {
        const source = this.sources.get(sourceId);
        if (!source) return { ok: false, reason: "sumber tidak dikenal" };
        if (source.kind !== SOURCE_KIND.REPLAY) return { ok: false, reason: "bukan sumber replay" };
        const session = this._sessionFor(source);
        const result = await source.load({
            onFrame: (frame) => {
                this.frameHistory.push(frame);
                const obs = this._frameToObservation(source, session, frame);
                if (obs.observation) {
                    this.observationsProduced += 1;
                    if (onObservations) onObservations(obs.observation);
                }
                else {
                    this.observationsRejected += 1;
                }
            }
        });
        this._refreshSourceStatuses();
        return result;
    }

    async startUdp(sourceId) {
        const source = this.sources.get(sourceId);
        if (!source) return { ok: false, reason: "sumber tidak dikenal" };
        if (source.kind !== SOURCE_KIND.UDP) return { ok: false, reason: "bukan sumber UDP" };
        const started = await source.start();
        this._refreshSourceStatuses();
        return started;
    }

    /** Frame UDP masuk → sesi → observasi (dipanggil onFrame source). */
    processUdpFrame(sourceId, frame) {
        const source = this.sources.get(sourceId);
        if (!source || source.kind !== SOURCE_KIND.UDP) return null;
        this.frameHistory.push(frame);
        const session = this._sessionFor(source);
        const obs = this._frameToObservation(source, session, frame);
        if (obs.observation) {
            this.observationsProduced += 1;
        }
        else {
            this.observationsRejected += 1;
        }
        return obs.observation;
    }

    _sessionFor(source) {
        let session = this.sessions.get(source.id);
        if (!session) {
            session = new RfProcessingSession({
                sensorId: source.sensorId,
                captureSession: `cs-${source.id}-${this.clock.nowMs().toString(36)}`,
                independenceGroup: source.sensorId, // satu sensor = satu grup
                location: this._sourceLocations.get(source.id) ?? null
            });
            this.sessions.set(source.id, session);
            // MD-014: kalibrasi terikat pada binding penuh — sensor, sesi,
            // sourceKind, dan channel bila diketahui. Replay dan live UDP
            // TIDAK PERNAH berbagi baseline (sourceKind bagian dari binding).
            this._calibrations.set(source.id, new RfCalibration({
                sensorId: source.sensorId,
                captureSession: session.captureSession,
                sourceKind: source.kind,
                channel: source.lastFrame?.channel ?? null,
                clock: this.clock
            }));
        }
        return session;
    }

    /** Frame → sesi → estimasi → observasi kanonik (atau null). */
    _frameToObservation(source, session, frame) {
        const estimate = session.update(frame);
        // MD-014: kalibrasi mengikuti setiap frame; energi frame dimasukkan
        // ke head window dan baseline difinalisasi dari sampel terkumpul.
        const calibration = this._calibrations.get(source.id);
        if (calibration) {
            calibration.recordFrameEnergy(estimate ? estimate.motionEnergy : null);
            if (calibration.state === CALIBRATION_STATE.COLLECTING ||
                calibration.state === CALIBRATION_STATE.UNCALIBRATED) {
                calibration.finalizeBaseline();
            }
        }
        if (!estimate) return { estimate: null, observation: null };
        const obs = this._estimateToObservation(source, session, estimate);
        return obs ? { estimate, observation: obs } : { estimate, observation: null };
    }

    /** Estimasi → SpatialObservation kanonik (atau null bila ditolak). */
    _estimateToObservation(source, session, estimate) {
        const nowMs = this.clock.nowMs();
        const capturedAtMs = source.lastFrameAtMs ?? nowMs;
        const typeName = estimate.presence === undefined
            ? OBSERVATION_TYPE.RF_MOTION_ESTIMATE
            : (estimate.presence
                ? OBSERVATION_TYPE.RF_PRESENCE_ESTIMATE
                : OBSERVATION_TYPE.RF_MOTION_ESTIMATE);

        // MD-014: metadata kalibrasi bounded (state/generation/quality) —
        // TANPA raw buffer. Tidak ada angka direkayasa bila belum sah.
        const calibration = this._calibrations.get(source.id);
        const calibrationMeta = calibration
            ? calibration.observationMetadata()
            : { calibrationState: "uncalibrated", calibrationGeneration: 0, calibrationQuality: null };

        const result = normalizeObservation({
            source: `mataDewa.rf:${source.sensorId}`,
            type: typeName,
            // RF: titik = lokasi sensor (dipasang trusted composition).
            geometry: session.location
                ? { type: "point", lat: session.location.lat, lon: session.location.lon }
                : null,
            observedAt: capturedAtMs,
            receivedAt: nowMs,
            confidence: estimate.confidence ?? 0.5,
            quality: 0.6,
            epistemic: estimate.epistemic ?? "INFERRED",
            accessClass: "PUBLIC",
            attributes: {
                sensorId: source.sensorId,
                captureSession: session.captureSession,
                sourceKind: source.kind,
                channel: source.kind === SOURCE_KIND.UDP
                    ? (Number.isFinite(source.lastFrame?.channel) ? source.lastFrame.channel : null)
                    : null,
                ...calibrationMeta,
                ...(session.location
                    ? { sensorLat: session.location.lat, sensorLon: session.location.lon, presence: estimate.presence ?? null }
                    : { presence: estimate.presence ?? null }),
                kind: estimate.presence === undefined ? "motion" : "presence",
                basis: estimate.basis ?? null,
                motionEnergy: Number(estimate.motionEnergy?.toFixed?.(4) ?? 0),
                quietBaseline: Number(estimate.quietBaseline?.toFixed?.(4) ?? 0),
                framesProcessed: session.framesProcessed,
                units: RF_UNITS
            },
            lineage: {
                kind: LINEAGE_KIND.SENSOR,
                providerId: source.sensorId,
                providerFamily: "mata-dewa-rf",
                independenceGroup: session.independenceGroup ?? source.sensorId,
                sensorId: source.sensorId,
                captureSession: session.captureSession,
                upstreamDataset: source.kind
            }
        }, { nowMs });
        if (!result.ok) {
            this.observationsRejected += 1;
            return null;
        }
        // MD-015/MD-017: TIDAK ada seal pra-penyimpanan di sini. Objek ini
        // BUKAN objek yang disimpan service (service menormalkan ulang →
        // objek baru). SEMUA bukti dikirim ke komposisi kanonik lewat
        // callback tepercaya — PRODUSEN HANYA MENGIRIM; OTORITAS (mint
        // domain) YANG MEMUTUSKAN: service menormalkan, meng-frozen,
        // menandai objek tersimpan BILA binding sah, lalu menyimpan.
        // sourceKind REPLAY/SIMULASI ditolak keras di mint (Repair 5) —
        // penegakan di otoritas, bukan di produsen. Tanpa callback
        // (RfManager langsung) → tidak ada bukti live kanonik (fail closed).
        if (this._trustedRfSubmit) {
            try {
                this._trustedRfSubmit(result.observation, {
                    sensorId: source.sensorId,
                    captureSession: session.captureSession,
                    sourceKind: source.kind,
                    channel: Number.isFinite(source.lastFrame?.channel)
                        ? source.lastFrame.channel : null,
                    calibration: calibration ? calibration.trustedDeclaration() : null
                });
            }
            catch { /* kegagalan submit tidak mengubah observasi (fail closed) */ }
        }
        return result.observation;
    }

    _refreshSourceStatuses() {
        this.lastSourceStatuses = [...this.sources.values()].map(s => s.describe());
    }

    /**
     * MD-014: invalidasi kalibrasi eksplisit (reconnect, ganti channel/config,
     * recalibration manual). Binding berubah → generation naik, baseline baru.
     */
    invalidateCalibration(sourceId, { reason = "binding_changed" } = {}) {
        const calibration = this._calibrations.get(sourceId);
        if (!calibration) return { ok: false, reason: "kalibrasi tidak dikenal" };
        const described = calibration.invalidate({ reason });
        return { ok: true, calibration: described };
    }

    status() {
        this._refreshSourceStatuses();
        return {
            sources: this.lastSourceStatuses,
            observationsProduced: this.observationsProduced,
            observationsRejected: this.observationsRejected,
            frameHistory: {
                size: this.frameHistory.size,
                dropped: this.frameHistory.dropped
            },
            sessions: [...this.sessions.values()].map(s => s.describe()),
            calibrations: [...this._calibrations.values()].map(c => c.describe())
        };
    }

    stop() {
        for (const source of this.sources.values()) {
            if (source.kind === SOURCE_KIND.UDP) source.stop();
        }
    }
}

/**
 * Pabrik komposisi kanonik — HANYA lewat sini (MD-008 spirit).
 * @param {object} [options] dijaga satu instance oleh pemanggil.
 */
function buildRfManager(options = {}) {
    return new RfManager(options);
}

module.exports = Object.freeze({
    RfManager,
    buildRfManager,
    RF_UNITS
});
