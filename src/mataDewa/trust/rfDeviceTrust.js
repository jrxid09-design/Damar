"use strict";

/**
 * RF DEVICE TRUST GATE — gerbang otorisasi EKSTERNAL yang sempit (Lane 5
 * integrasi post-Lane4).
 *
 * HUKUM:
 *  - SEMANTIK createRfTrustDomain() TIDAK DIUBAH. Domain trust RF tetap
 *    membuktikan "observasi tersimpan ini lewat pipeline RF live kanonik";
 *    modul ini TIDAK menyentuhnya. Gerbang ini HANYA ditanya oleh
 *    komposisi (closure ingest service) SEBELUM mint dipanggil.
 *  - RF TRUST != DEVICE ENROLLMENT dan DEVICE != OWNER: status perangkat
 *    datang dari binding perangkat OwnerTrust KANONIK yang tersertifikasi
 *    (kind "device", peer "device:<deviceId>") — BUKAN dari string
 *    deviceId pemanggil, BUKAN dari metadata RF, BUKAN dari salinan objek.
 *  - State kanonik minimal: UNENROLLED / TRUSTED / REVOKED.
 *    REVOKED berlaku SEGERA: binding dicabut di registry → state langsung
 *    REVOKED (tidak ada cache keputusan positif).
 *  - REPLAY/SIMULASI tetap non-produksi APA PUN state perangkatnya.
 *  - Device trust TIDAK memberi otoritas Owner apa pun: gerbang ini hanya
 *    menjawab "sumber live ini boleh jadi kandidat produksi-live".
 *  - Setiap mutasi (enroll/revoke) diaudit DULU; audit gagal → mutasi
 *    ditolak (kebijakan mutasi trust tersertifikasi).
 */

const DEVICE_STATES = Object.freeze({
    UNENROLLED: "UNENROLLED",
    TRUSTED: "TRUSTED",
    REVOKED: "REVOKED"
});

const MAX_RECORDS = 256;
const MAX_ID_CHARS = 128;

function validId(value) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= MAX_ID_CHARS && /^[\x20-\x7E]+$/.test(value);
}

function devicePeer(deviceId) {
    return `device:${deviceId}`;
}

/**
 * @param {object} params
 * @param {object} params.registry   registry OwnerTrust kanonik (tersertifikasi)
 * @param {{ nowMs(): number }} [params.clock]
 * @param {Function} [params.audit]  sink audit ({eventType, source, actor, subject, outcome, metadata})
 *     → { ok:boolean } ; audit gagal → mutasi ditolak (AUDIT_UNAVAILABLE).
 */
function createRfDeviceTrustGate({ registry, clock = { nowMs: () => Date.now() }, audit = null } = {}) {
    if (!registry || typeof registry.findBinding !== "function" ||
        typeof registry.principalState !== "function") {
        throw new TypeError("RF_DEVICE_TRUST_INVALID: registry OwnerTrust kanonik wajib ada");
    }

    /** sensorId → { deviceId, principalId, method, enrolledAtMs, revoked } */
    const records = new Map();

    function emit(input) {
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

    /** Binding perangkat KANONIK aktif + principal aktif + generasi segar. */
    function activeDeviceBinding(deviceId) {
        if (!validId(deviceId)) return null;
        const binding = registry.findBinding({ kind: "device", peer: devicePeer(deviceId) });
        if (!binding) return null;
        if (registry.principalState(binding.principalId) !== "ACTIVE") return null;
        const principal = typeof registry.getPrincipal === "function"
            ? registry.getPrincipal(binding.principalId) : null;
        if (principal && typeof principal.generation === "number" &&
            binding.generation < principal.generation) {
            return null; // binding basi (rotasi/revokasi kredensial)
        }
        return binding;
    }

    /**
     * State kanonik sensorId. Tidak ada keputusan positif yang di-cache:
     * revokasi di registry berlaku pada pertanyaan BERIKUTNYA.
     */
    function stateOf(sensorId) {
        const rec = records.get(sensorId);
        if (!rec) return DEVICE_STATES.UNENROLLED;
        if (rec.revoked) return DEVICE_STATES.REVOKED;
        if (!activeDeviceBinding(rec.deviceId)) return DEVICE_STATES.REVOKED;
        return DEVICE_STATES.TRUSTED;
    }

    /**
     * Gerbang pra-mint komposisi: sumber live ini boleh jadi kandidat
     * produksi-live? REPLAY/SIMULASI selalu ditolak; state wajib TRUSTED.
     * Tidak menerima objek metadata apa pun dari pemanggil — hanya id.
     */
    function authorizeLiveBinding({ sensorId, sourceKind } = {}) {
        if (sourceKind !== "udp") {
            return { ok: false, state: DEVICE_STATES.UNENROLLED,
                reason: "sumber non-live (replay/simulasi) tidak pernah produksi-live" };
        }
        if (!validId(sensorId)) {
            return { ok: false, state: DEVICE_STATES.UNENROLLED, reason: "sensorId tidak valid" };
        }
        const state = stateOf(sensorId);
        if (state !== DEVICE_STATES.TRUSTED) {
            return { ok: false, state, reason: `perangkat RF ${state} — produksi-live ditolak` };
        }
        return { ok: true, state, deviceId: records.get(sensorId).deviceId };
    }

    /**
     * Enroll sensorId ↔ deviceId. WAJIB sudah ada binding perangkat kanonik
     * AKTIF untuk deviceId (dibuat lewat pairing+bind Owner tersertifikasi).
     * String deviceId pemanggil TIDAK pernah cukup sendirinya.
     */
    function enroll({ sensorId, deviceId } = {}) {
        if (!validId(sensorId) || !validId(deviceId)) {
            return { ok: false, code: "RF_DEVICE_ID_INVALID", reason: "sensorId + deviceId wajib (string aman)" };
        }
        if (records.size >= MAX_RECORDS && !records.has(sensorId)) {
            return { ok: false, code: "RF_DEVICE_LIMIT", reason: "batas enrollment tercapai" };
        }
        const existing = records.get(sensorId);
        if (existing && existing.revoked) {
            return { ok: false, code: "RF_DEVICE_REVOKED", reason: "sensor direvokal — enroll ulang dilarang" };
        }
        const binding = activeDeviceBinding(deviceId);
        if (!binding) {
            return { ok: false, code: "RF_DEVICE_NOT_BOUND",
                reason: "tidak ada binding perangkat OwnerTrust kanonik aktif untuk deviceId ini" };
        }
        const prior = emit({
            eventType: "matadewa.rf.device.enrolled",
            source: "matadewa.trust",
            actor: { kind: "user", id: binding.principalId },
            subject: { kind: "device", id: sensorId },
            outcome: "ok",
            metadata: { deviceId }
        });
        if (!prior.ok) {
            return { ok: false, code: prior.code, reason: "audit gagal — enrollment ditolak (fail closed)" };
        }
        records.set(sensorId, {
            deviceId,
            principalId: binding.principalId,
            method: "ownertrust-device-binding",
            enrolledAtMs: clock.nowMs(),
            revoked: false
        });
        return { ok: true, sensorId, deviceId, principalId: binding.principalId };
    }

    /** Revoke SEGERA: state berikutnya REVOKED, sumber live boleh dimatikan pemanggil. */
    function revoke({ sensorId, reason = "owner-revocation" } = {}) {
        const rec = records.get(sensorId);
        if (!rec) {
            return { ok: false, code: "RF_DEVICE_UNKNOWN", reason: "sensor tidak terdaftar" };
        }
        const verdict = emit({
            eventType: "matadewa.rf.device.revoked",
            source: "matadewa.trust",
            actor: { kind: "service", id: "matadewa.rfControl" },
            subject: { kind: "device", id: sensorId },
            outcome: "ok",
            metadata: { deviceId: rec.deviceId, reason: String(reason).slice(0, 96) }
        });
        if (!verdict.ok) {
            return { ok: false, code: verdict.code, reason: "audit gagal — revokasi ditolak (fail closed)" };
        }
        rec.revoked = true;
        return { ok: true, sensorId, deviceId: rec.deviceId };
    }

    /** View tanpa material sensitif (id + state + waktu saja). */
    function snapshot() {
        return [...records.entries()].map(([sensorId, rec]) => ({
            sensorId,
            deviceId: rec.deviceId,
            principalId: rec.principalId,
            state: stateOf(sensorId),
            enrolledAtMs: rec.enrolledAtMs
        }));
    }

    return Object.freeze({
        DEVICE_STATES,
        stateOf,
        authorizeLiveBinding,
        enroll,
        revoke,
        snapshot
    });
}

module.exports = Object.freeze({
    createRfDeviceTrustGate,
    RF_DEVICE_STATES: DEVICE_STATES
});
