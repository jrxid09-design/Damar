/**
 * Media / CCTV Mata Dewa — hanya kamera PUBLIK atau BEROTORISASI PENGGUNA.
 *
 * HUKUM:
 *  - Tidak ada penemuan/akses kamera tanpa izin (no unauthorized camera
 *    discovery/access). Sumber RESTRICTED/UNAVAILABLE fail-closed.
 *  - Frame dikonsumsi lewat jahitan MediaIngress Damar (bukan router VLM
 *    kedua): mataDewa.media.reference → ingest bytes → mediaRef kanonik
 *    (media:<id>) → jalur multimodal Damar yang ada.
 */

const { ACCESS_CLASS, canonical: canonicalAccess, requiresAuthorization } = require("../spatial/accessClass");
const { normalizeAsset, ASSET_TYPE } = require("../assets/assetRegistry");

const CAMERA_ACCESS = Object.freeze({
    PUBLIC: "PUBLIC",
    AUTHORIZED_DEVICE: "AUTHORIZED_DEVICE",
    RESTRICTED: "RESTRICTED",
    UNAVAILABLE: "UNAVAILABLE"
});

/**
 * CameraRegistry — daftar kamera yang boleh dikonsumsi.
 * Registrasi hanya lewat: sumber publik terdaftar, atau otorisasi eksplisit
 * pengguna (perangkat miliknya). Tidak ada mekanisme "temukan" otomatis.
 */
class CameraRegistry {

    constructor() {
        /** @type {Map<string, object>} id → kamera */
        this.cameras = new Map();
    }

    /**
     * Daftarkan kamera publik (URL terdaftar, bukan arbitrer — mitigasi SSRF).
     */
    registerPublicCamera({ id, label, location, snapshotUrl, metadata = {} }) {
        return this._register({ id, label, location, snapshotUrl, metadata, accessClass: CAMERA_ACCESS.PUBLIC });
    }

    /**
     * Daftarkan kamera berotorisasi (perangkat pengguna / HA). Kredensial
     * snapshot ditangani daemon via jalur proksi yang ada — tidak pernah
     * dikirim ke renderer.
     */
    registerAuthorizedCamera(input) {
        return this._register({ ...input, accessClass: CAMERA_ACCESS.AUTHORIZED_DEVICE });
    }

    _register({ id, label, location, snapshotUrl, metadata, accessClass }) {
        if (!id || !snapshotUrl) {
            return { ok: false, reason: "kamera butuh id + snapshotUrl terdaftar" };
        }
        const normalized = normalizeAsset({
            id: `cctv_${id}`,
            type: ASSET_TYPE.CCTV,
            location: location ?? null,
            geometry: location ? { type: "point", lat: location.lat, lon: location.lon } : null,
            metadata: { label: label ?? id, snapshotUrl: String(snapshotUrl), ...metadata },
            accessClass
        });
        if (!normalized.ok) return normalized;
        const camera = {
            ...normalized.asset,
            cameraAccess: accessClass,
            coverageKnown: false // field-of-view hanya bila diketahui dari sumber
        };
        this.cameras.set(camera.id, camera);
        return { ok: true, camera };
    }

    get(id) { return this.cameras.get(id) ?? null; }
    list() { return [...this.cameras.values()]; }

    /**
     * Apakah frame kamera ini boleh diambil sekarang. Fail-closed:
     * RESTRICTED/UNAVAILABLE selalu ditolak, tanpa bypass.
     */
    canFetch(id) {
        const camera = this.cameras.get(id);
        if (!camera) return { ok: false, reason: "kamera tidak terdaftar" };
        if (camera.cameraAccess === CAMERA_ACCESS.RESTRICTED ||
            camera.cameraAccess === CAMERA_ACCESS.UNAVAILABLE) {
            return { ok: false, reason: `akses ${camera.cameraAccess} — fail-closed, tidak ditembus` };
        }
        return { ok: true, camera };
    }
}

/**
 * Referensi media frame untuk jalur multimodal Damar.
 * Mengembalikan descriptor yang siap diteruskan ke MediaIngress.ingest oleh
 * pemanggil (controller/plugin), bukan mengambil sendiri di sini — pemisahan
 * ini menjaga satu router multimodal (milik Damar).
 */
function frameMediaDescriptor(camera, { frameUrl = null, capturedAtMs = Date.now() } = {}) {
    return {
        source: "mataDewa.cctv",
        cameraId: camera.id,
        accessClass: camera.cameraAccess,
        snapshotUrl: frameUrl ?? camera.metadata.snapshotUrl,
        capturedAtMs,
        declaredMimeType: "image/jpeg",
        sourceChannel: "camera",
        // Nyalakan: pemanggil meng-ingest bytes ini via MediaIngress Damar.
        instruction: "ingest_via_media_ingress"
    };
}

module.exports = {
    CameraRegistry,
    CAMERA_ACCESS,
    frameMediaDescriptor,
    requiresAuthorization
};
