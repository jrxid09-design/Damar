"use strict";

/**
 * PERMUKAAN KONTROL RF TERISTIMEWA (Lane 5 Integrasi 4) — sisi service.
 *
 * OWNS: satu-satunya tempat mutasi RF live terjadi di service Mata Dewa.
 * Objek ini NON-ENUMERABLE di service dan DITITIPKAN hanya kepada actuator
 * Action Fabric kanonik (wireMataDewaRfControlActuators → Lane 3 execute).
 * Pemanggil arbitrer (model output/route/MCP) tidak punya permukaan ini:
 * satu-satunya jalan produksi adalah Action Intent → Authority kanonik →
 * Actuation Fabric → actuator → sini.
 *
 * HUKUM:
 *   - FAIL CLOSED: gerbang perangkat tidak terkomposisi → enable/enroll
 *     ditolak. allowLocalUdp tidak diset komposisi → enable ditolak.
 *   - enable WAJIB perangkat TRUSTED (Integrasi 3) + audit OK (Integrasi 6).
 *   - revoke SEGERA: sumber live sensor yang sama dimatikan pada saat itu.
 *   - Setiap mutasi diaudit SEBELUM efek; audit gagal → mutasi ditolak.
 *   - Tidak ada mekanisme bypass: metode ini tidak pernah diekspos lewat
 *     index.js/public API; ia hanya diakses lewat closure actuator.
 */

const { CAPTURE_LIMITS } = require("../rf/capture/sources");

const MAX_PORT = 65535;

function safeId(value, max = 96) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, max);
    if (!trimmed.length || !/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return null;
    return trimmed;
}

function safeReason(value, max = 128) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, max);
    return trimmed.length ? trimmed : null;
}

function auditOk(audit, input) {
    if (!audit) return { ok: true };
    try {
        const result = audit(input);
        if (result && typeof result === "object" && result.ok === false) {
            return { ok: false, code: result.code ?? "AUDIT_REJECTED" };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, code: "AUDIT_UNAVAILABLE" };
    }
}

/**
 * @param {object} params
 * @param {object} params.service          MataDewaService (komposisi kanonik)
 * @param {Function} params.gateAccessor   () → rfDeviceTrustGate | null
 * @param {Function} params.auditAccessor  () → audit sink | null
 * @param {boolean} params.allowLocalUdp   komposisi-level (satu pintu UDP)
 */
function createRfControlSurface({ service, gateAccessor, auditAccessor, allowLocalUdp = false } = {}) {
    if (!service || !service.rfManager) {
        throw new TypeError("RF_CONTROL_INVALID: service + rfManager wajib ada");
    }
    if (typeof gateAccessor !== "function" || typeof auditAccessor !== "function") {
        throw new TypeError("RF_CONTROL_INVALID: gateAccessor + auditAccessor wajib ada");
    }

    /** sourceId → { sensorId, source } untuk sumber live yang kita buat. */
    const liveSources = new Map();

    function assertOperational() {
        if (service.state === "TERMINATED" || service._shutdownRequested) {
            return { ok: false, reason: "service sudah berhenti" };
        }
        return { ok: true };
    }

    function requireGate() {
        const gate = gateAccessor();
        if (!gate) {
            return { ok: false, code: "RF_DEVICE_GATE_NOT_COMPOSED",
                reason: "gerbang perangkat RF kanonik tidak terkomposisi (fail-closed)" };
        }
        return { ok: true, gate };
    }

    return {
        /**
         * Aktifkan listener RF live (loopback). Butuh: komposisi allowLocalUdp,
         * gerbang terkomposisi, perangkat TRUSTED, audit OK, lokasi sensor sah.
         */
        enable({ sensorId, deviceId = null, bindPort = null, location = null, label = null } = {}) {
            const op = assertOperational();
            if (!op.ok) return { ok: false, code: "SERVICE_NOT_OPERATIONAL", reason: op.reason };
            if (!allowLocalUdp) {
                return { ok: false, code: "AUTHORIZED_LOCAL_SOURCE_REJECTED",
                    reason: "allowLocalUdp tidak diberikan trusted composition (fail-closed)" };
            }
            const sid = safeId(sensorId);
            if (!sid) return { ok: false, code: "RF_DEVICE_ID_INVALID", reason: "sensorId tidak sah" };
            const gateCheck = requireGate();
            if (!gateCheck.ok) return gateCheck;
            const gate = gateCheck.gate;
            if (gate.stateOf(sid) !== gate.DEVICE_STATES.TRUSTED) {
                return { ok: false, code: "RF_DEVICE_NOT_TRUSTED",
                    reason: `perangkat RF ${gate.stateOf(sid)} — listener live ditolak (Integrasi 3)` };
            }
            const record = gate.snapshot().find((r) => r.sensorId === sid);
            if (deviceId != null) {
                const did = safeId(deviceId, 128);
                if (!did || record?.deviceId !== did) {
                    return { ok: false, code: "RF_DEVICE_MISMATCH", reason: "deviceId tidak cocok dengan enrollment" };
                }
            }
            const port = bindPort == null ? 0 : Number(bindPort);
            if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
                return { ok: false, code: "RF_BIND_PORT_INVALID", reason: "bindPort tidak sah" };
            }
            if (!location || typeof location !== "object" ||
                !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
                return { ok: false, code: "RF_LOCATION_REQUIRED", reason: "lokasi sensor {lat,lon} wajib" };
            }
            const sourceId = `rf_udp_${sid}`;
            if (liveSources.has(sourceId)) {
                return { ok: false, code: "RF_SOURCE_EXISTS", reason: "listener live untuk sensor ini sudah aktif" };
            }
            const verdict = auditOk(auditAccessor(), {
                eventType: "matadewa.rf.listener.enabled",
                actor: { kind: "service", id: "matadewa.rfControl" },
                subject: { kind: "device", id: sid },
                outcome: "ok",
                metadata: { deviceId: record.deviceId, bindPort: port, label: safeReason(label) }
            });
            if (!verdict.ok) {
                return { ok: false, code: verdict.code, reason: "audit gagal — enable ditolak (fail closed)" };
            }
            const added = service.rfManager.addUdpSource({
                id: sourceId,
                sensorId: sid,
                bindAddress: "127.0.0.1",
                bindPort: port,
                maxRateHz: CAPTURE_LIMITS.DEFAULT_MAX_RATE_HZ,
                location: { lat: location.lat, lon: location.lon }
            });
            if (!added.ok) {
                return { ok: false, code: "RF_SOURCE_ADD_FAILED", reason: added.reason ?? "gagal menambah sumber" };
            }
            liveSources.set(sourceId, { sensorId: sid, source: added.source });
            return { ok: true, sourceId, sensorId: sid, deviceId: record.deviceId };
        },

        /** Matikan listener live (idempotent; audit best-effort ditolak-fail). */
        disable({ sensorId } = {}) {
            const sid = safeId(sensorId);
            if (!sid) return { ok: false, code: "RF_DEVICE_ID_INVALID", reason: "sensorId tidak sah" };
            const sourceId = `rf_udp_${sid}`;
            const entry = liveSources.get(sourceId);
            if (!entry) return { ok: false, code: "RF_SOURCE_UNKNOWN", reason: "tidak ada listener live untuk sensor ini" };
            const verdict = auditOk(auditAccessor(), {
                eventType: "matadewa.rf.listener.disabled",
                actor: { kind: "service", id: "matadewa.rfControl" },
                subject: { kind: "device", id: sid },
                outcome: "ok",
                metadata: null
            });
            if (!verdict.ok) {
                return { ok: false, code: verdict.code, reason: "audit gagal — disable ditolak (fail closed)" };
            }
            entry.source.stop();
            service.rfManager.sources.delete(sourceId);
            service.rfManager._sourceLocations.delete(sourceId);
            liveSources.delete(sourceId);
            return { ok: true, sourceId };
        },

        /** Enroll perangkat RF (butuh binding perangkat OwnerTrust aktif). */
        enroll({ sensorId, deviceId } = {}) {
            const op = assertOperational();
            if (!op.ok) return { ok: false, code: "SERVICE_NOT_OPERATIONAL", reason: op.reason };
            const gateCheck = requireGate();
            if (!gateCheck.ok) return gateCheck;
            return gateCheck.gate.enroll({ sensorId: safeId(sensorId), deviceId });
        },

        /** Revoke SEGERA: state REVOKED + listener live sensor ini dimatikan. */
        revoke({ sensorId, reason = null } = {}) {
            const sid = safeId(sensorId);
            if (!sid) return { ok: false, code: "RF_DEVICE_ID_INVALID", reason: "sensorId tidak sah" };
            const gateCheck = requireGate();
            if (!gateCheck.ok) return gateCheck;
            const result = gateCheck.gate.revoke({ sensorId: sid, reason: safeReason(reason) ?? "owner-revocation" });
            if (!result.ok) return result;
            // Revokasi berlaku segera: matikan sumber live sensor ini.
            const sourceId = `rf_udp_${sid}`;
            const entry = liveSources.get(sourceId);
            if (entry) {
                entry.source.stop();
                service.rfManager.sources.delete(sourceId);
                service.rfManager._sourceLocations.delete(sourceId);
                liveSources.delete(sourceId);
            }
            return result;
        },

        /** Reset baseline kalibrasi sumber (butuh grant ter-ratifikasi). */
        recalibrate({ sensorId, reason = null } = {}) {
            const op = assertOperational();
            if (!op.ok) return { ok: false, code: "SERVICE_NOT_OPERATIONAL", reason: op.reason };
            const sid = safeId(sensorId);
            if (!sid) return { ok: false, code: "RF_DEVICE_ID_INVALID", reason: "sensorId tidak sah" };
            const verdict = auditOk(auditAccessor(), {
                eventType: "matadewa.rf.calibration.reset",
                actor: { kind: "service", id: "matadewa.rfControl" },
                subject: { kind: "device", id: sid },
                outcome: "ok",
                metadata: { reason: safeReason(reason) }
            });
            if (!verdict.ok) {
                return { ok: false, code: verdict.code, reason: "audit gagal — reset ditolak (fail closed)" };
            }
            // Hasil manager jujur: sumber tanpa kalibrasi (belum ada frame)
            // melapor "kalibrasi tidak dikenal" — bukan keberhasilan palsu.
            return service.rfManager.invalidateCalibration(`rf_udp_${sid}`, { reason: "owner-authorized-reset" });
        },

        /** View read-only untuk actuator result (tanpa material sensitif). */
        liveSources() {
            return [...liveSources.keys()];
        }
    };
}

module.exports = Object.freeze({ createRfControlSurface });
