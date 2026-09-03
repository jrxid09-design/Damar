/**
 * Media / CCTV Mata Dewa (MD-004 hardened).
 *
 * HUKUM:
 *  - Tidak ada penemuan/akses kamera tanpa izin. RESTRICTED/UNAVAILABLE
 *    fail-closed, dan AUTHORIZED_DEVICE tidak bisa didaftarkan oleh
 *    pemanggil arbitrer: pra-Lane4, permintaan otorisasi kamera milik
 *    pemilik DITOLAK dengan OWNER_TRUST_NOT_INTEGRATED — tidak ada
 *    permukaan API yang memalsukan otorisasi.
 *  - Raw URL snapshot TIDAK PERNAH berarti otorisasi, dan
 *    frameMediaDescriptor TIDAK menjadi fetch token: deskriptor hanya
 *    membawa identitas kamera terdaftar (cameraRef) + kelas akses —
 *    URL mentah tidak pernah ikut ditulis ke deskriptor/hasil.
 *  - Pengambilan frame HANYA lewat batas jaringan kanonik Damar
 *    (http.js → ssrfGuard) dengan kebijakan PUBLIC_REMOTE_PROVIDER:
 *    host penyedia = host kamera yang terdaftar; hop redirect harus
 *    tetap di host yang sama (fail-closed).
 *  - Frame dikonsumsi lewat jahitan MediaIngress Damar (bukan router VLM
 *    kedua). Bila MediaIngress kanonik belum dikomposisi (daemon saat
 *    ini), langkah tersebut melapor MEDIA_INGRESS_NOT_COMPOSED secara
 *    jujur (POST-LANE4), TIDAK menembusnya dengan router kedua.
 */

const { ACCESS_CLASS, canonical: canonicalAccess, requiresAuthorization } = require("../spatial/accessClass");
const { normalizeAsset, ASSET_TYPE } = require("../assets/assetRegistry");

const CAMERA_ACCESS = Object.freeze({
    PUBLIC: "PUBLIC",
    AUTHORIZED_DEVICE: "AUTHORIZED_DEVICE",
    RESTRICTED: "RESTRICTED",
    UNAVAILABLE: "UNAVAILABLE"
});

const MAX_FRAME_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_FRAME_TIMEOUT_MS = 15000;

/**
 * CameraRegistry — daftar kamera yang boleh dikonsumsi.
 * Registrasi publik hanya lewat trusted composition (registerPublicCamera).
 */
class CameraRegistry {

    constructor() {
        /** @type {Map<string, object>} id → kamera */
        this.cameras = new Map();
    }

    /**
     * Daftarkan kamera publik (konfigurasi trusted composition). Host
     * snapshot URL menjadi allowlist penyedia pada saat FETCH — registrasi
     * bukan otorisasi; URL mentah tidak pernah diberi makna otoritatif.
     */
    registerPublicCamera({ id, label, location, snapshotUrl, metadata = {} }) {
        if (!id || !snapshotUrl) {
            return { ok: false, reason: "kamera butuh id + snapshotUrl terdaftar" };
        }
        let parsed;
        try {
            parsed = new URL(String(snapshotUrl));
        }
        catch {
            return { ok: false, reason: "snapshotUrl tidak sah" };
        }
        if (parsed.protocol !== "https:") {
            return { ok: false, reason: "snapshot kamera publik wajib HTTPS (fail-closed)" };
        }
        return this._register({ id, label, location, snapshotUrl: parsed.toString(), metadata, accessClass: CAMERA_ACCESS.PUBLIC });
    }

    /**
     * MD-004: permintaan otorisasi kamera MILIK-OWNER → FAIL CLOSED
     * pra-Lane4. Pemanggil arbitrer TIDAK BISA menandai kamera sebagai
     * AUTHORIZED_DEVICE dengan URL semaunya; integrasi trust perangkat
     * kanonik (Lane 4 tersertifikasi) wajib ada dulu.
     */
    registerAuthorizedCamera() {
        return {
            ok: false,
            code: "OWNER_TRUST_NOT_INTEGRATED",
            reason: "otorisasi kamera pemilik belum terintegrasi (post-Lane4) — " +
                "tidak ada permukaan API yang memalsukan otorisasi perangkat"
        };
    }

    _register({ id, label, location, snapshotUrl, metadata, accessClass }) {
        const cameraId = `cctv_${id}`;
        const hasValidLocation = location !== null && location !== undefined &&
            Number.isFinite(location.lat) && Number.isFinite(location.lon);
        const camera = {
            id: cameraId,
            type: ASSET_TYPE.CCTV,
            // Kamera tanpa lokasi valid tetap bisa didaftarkan untuk fetch —
            // geometry bukan prasyarat pengambilan frame.
            location: hasValidLocation ? { lat: location.lat, lon: location.lon } : null,
            geometry: hasValidLocation
                ? { type: "point", lat: location.lat, lon: location.lon }
                : null,
            metadata: {
                label: label ?? id,
                // Host saja tersimpan (bukan URL penuh) — deskriptor media
                // tidak membawa token URL; fetch memakai host yang
                // terdaftar sebagai allowlist penyedia.
                snapshotHost: canonicalHostOf(snapshotUrl),
                ...metadata,
                snapshotUrl
            },
            accessClass,
            cameraAccess: accessClass,
            coverageKnown: false // field-of-view hanya bila diketahui dari sumber
        };
        // Kamera DENGAN lokasi ikut masuk asset registry spasial.
        if (hasValidLocation) {
            const normalized = normalizeAsset({
                id: cameraId,
                type: ASSET_TYPE.CCTV,
                location: camera.location,
                geometry: camera.geometry,
                metadata: camera.metadata,
                accessClass
            });
            if (!normalized.ok) return normalized;
            Object.assign(camera, { coverageKnown: false });
        }
        this.cameras.set(cameraId, camera);
        return { ok: true, camera };
    }

    get(id) { return this.cameras.get(id) ?? null; }
    list() { return [...this.cameras.values()]; }

    /**
     * Apakah frame kamera ini boleh diambil sekarang. Fail-closed:
     * RESTRICTED/UNAVAILABLE selalu ditolak; AUTHORIZED_DEVICE pun tidak
     * pernah ada (registrasinya ditolak) — tidak ada bypass.
     */
    canFetch(id) {
        const camera = this.cameras.get(id);
        if (!camera) return { ok: false, reason: "kamera tidak terdaftar" };
        if (camera.cameraAccess !== CAMERA_ACCESS.PUBLIC) {
            return { ok: false, reason: `akses ${camera.cameraAccess} — fail-closed, tidak ditembus` };
        }
        const host = camera.metadata?.snapshotHost;
        if (!host) {
            return { ok: false, reason: "kamera tanpa snapshotHost terdaftar" };
        }
        return { ok: true, camera };
    }
}

function canonicalHostOf(urlString) {
    try {
        return new URL(String(urlString)).hostname.toLowerCase().replace(/\.$/, "");
    }
    catch {
        return null;
    }
}

/**
 * Referensi media frame untuk jalur multimodal Damar — INERT.
 * MD-004: tidak membawa URL mentah (bukan fetch token); hanya identitas
 * kamera terdaftar + kelas akses + instruksi ingest. Pengambilan bytes
 * HANYA lewat acquirePublicCameraFrame (batas jaringan kanonik).
 */
function frameMediaDescriptor(camera) {
    if (!camera) return null;
    return Object.freeze({
        // cameraRef = identitas terdaftar; BUKAN URL.
        mediaRef: `mataDewa.cctv:${camera.id}`,
        cameraId: camera.id,
        source: "mataDewa.cctv",
        accessClass: camera.cameraAccess,
        declaredMimeType: "image/jpeg",
        sourceChannel: "camera",
        capturedAtMs: null, // diisi oleh acquirePublicCameraFrame
        // Nyalakan: pemanggil meng-ingest bytes via MediaIngress Damar.
        instruction: "ingest_via_media_ingress"
    });
}

/**
 * MD-004 end-to-end sejauh baseline mengizinkan: kamera PUBLIK → batas
 * jaringan kanonik → bytes bounded → deskriptor inert + opsi ingest ke
 * MediaIngress Damar (fail-closed bila belum dikomposisi).
 *
 * @param {CameraRegistry} cameraRegistry
 * @param {string} cameraId
 * @param {{ maxBytes?, timeoutMs? }} opts
 * @returns {Promise<{ok:true, bytes:Buffer, contentType:string,
 *           mediaDescriptor:object, mediaIngest:{ok:boolean, code?, reason?}}
 *           | {ok:false, code?:string, reason:string}>}
 */
async function acquirePublicCameraFrame(cameraRegistry, cameraId, opts = {}) {
    const verdict = cameraRegistry.canFetch(cameraId);
    if (!verdict.ok) {
        return { ok: false, reason: verdict.reason };
    }
    const camera = verdict.camera;
    const snapshotUrl = camera.metadata?.snapshotUrl;
    const snapshotHost = camera.metadata?.snapshotHost;
    if (!snapshotUrl || !snapshotHost) {
        return { ok: false, reason: "kamera tanpa snapshot terdaftar" };
    }

    const { fetchBuffer } = require("../providers/http");
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
        ? Math.min(opts.maxBytes, MAX_FRAME_BYTES) : MAX_FRAME_BYTES;

    // Kebijakan PUBLIC_REMOTE_PROVIDER: host terdaftar = satu-satunya
    // allowlist; redirect ke host berbeda ditolak (fail-closed).
    let buffer;
    try {
        buffer = await fetchBuffer(snapshotUrl, {
            allowedHosts: [snapshotHost],
            maxBytes,
            timeoutMs: opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
            expectedContentType: "image"
        });
    }
    catch (error) {
        return { ok: false, code: "SNAPSHOT_FETCH_FAILED", reason: String(error.message).slice(0, 240) };
    }
    const descriptor = Object.freeze({
        ...frameMediaDescriptor(camera),
        capturedAtMs: Date.now(),
        sizeBytes: buffer.length
    });

    // Jahitan MediaIngress Damar: pasok bila komposisi menguatkan
    // (trusted composition); kalau tidak → melapor jujur, TIDAK menembus.
    const mediaIngest = opts.mediaIngress
        ? await tryIngestViaMediaIngress(opts.mediaIngress, camera, buffer, descriptor)
        : {
            ok: false,
            code: "MEDIA_INGRESS_NOT_COMPOSED",
            reason: "MediaIngress kanonik Damar belum dikomposisi di daemon — post-Lane4 (inert, tidak ada link kedua)"
        };

    return { ok: true, bytes: buffer, contentType: "image/jpeg", mediaDescriptor: descriptor, mediaIngest };
}

/** Inert: stringify bytes sekaligus menghindari getter hostil. */
async function tryIngestViaMediaIngress(mediaIngress, camera, buffer, descriptor) {
    if (!mediaIngress || typeof mediaIngress.ingest !== "function") {
        return {
            ok: false,
            code: "MEDIA_INGRESS_INVALID",
            reason: "objek mediaIngress tidak punya ingest()"
        };
    }
    try {
        const reference = await mediaIngress.ingest({
            bytes: buffer,
            sourceChannel: "camera",
            mediaType: "image/jpeg",
            metadata: descriptor
        });
        if (reference && reference.mediaRef) {
            return { ok: true, mediaRef: reference.mediaRef };
        }
        return { ok: false, code: "MEDIA_INGRESS_NO_REF", reason: "MediaIngress tidak mengembalikan mediaRef" };
    }
    catch (error) {
        return { ok: false, code: "MEDIA_INGRESS_FAILED", reason: String(error.message).slice(0, 240) };
    }
}

module.exports = {
    CameraRegistry,
    CAMERA_ACCESS,
    frameMediaDescriptor,
    acquirePublicCameraFrame,
    tryIngestViaMediaIngress,
    requiresAuthorization
};