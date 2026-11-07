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
     * MD-004 + Integrasi 2 (post-Lane4): permintaan otorisasi kamera
     * MILIK-OWNER hanya sah lewat jembatan trust kanonik. Pemanggil tanpa
     * jembatan tetap DITOLAK dengan OWNER_TRUST_NOT_INTEGRATED (tidak ada
     * permukaan API yang memalsukan otorisasi perangkat); pemanggil DENGAN
     * jembatan harus membuktikan principal Owner/Admin terautentikasi +
     * binding perangkat kanonik aktif, lalu menerima token SEALED dari
     * jembatan — string/flag pemanggil tidak pernah cukup.
     */
    registerAuthorizedCamera({ id, label, location, snapshotUrl, metadata = {}, deviceId = null, authorization = null, cameraAuthorizer = null } = {}) {
        if (!id || !snapshotUrl) {
            return { ok: false, code: "OWNER_TRUST_NOT_INTEGRATED", reason: "kamera butuh id + snapshotUrl terdaftar" };
        }
        // Jalur pra-integrasi: tanpa jembatan kanonik, selalu ditolak.
        if (!cameraAuthorizer || typeof cameraAuthorizer.mintCameraRegistrationToken !== "function" ||
            typeof cameraAuthorizer.verifySealedToken !== "function") {
            return {
                ok: false,
                code: "OWNER_TRUST_NOT_INTEGRATED",
                reason: "otorisasi kamera pemilik belum terintegrasi (post-Lane4) — " +
                    "tidak ada permukaan API yang memalsukan otorisasi perangkat"
            };
        }
        // Argumen otorisasi dari pemanggil (authorized/force/accessClass
        // dll.) TIDAK PERNAH bermakna otoritatif — diabaikan keras.
        if (!deviceId || typeof deviceId !== "string") {
            return { ok: false, code: "CAMERA_DEVICE_BINDING_REQUIRED", reason: "deviceId wajib (binding perangkat kanonik)" };
        }
        const mint = cameraAuthorizer.mintCameraRegistrationToken({ evidence: authorization, deviceId });
        if (!mint.ok) {
            return { ok: false, code: mint.code ?? "PRINCIPAL_NOT_AUTHENTICATED", reason: mint.reason ?? "otorisasi jembatan ditolak" };
        }
        if (!cameraAuthorizer.verifySealedToken(mint.token, deviceId)) {
            return { ok: false, code: "CAMERA_AUTHORIZATION_SEAL_INVALID", reason: "token otorisasi tidak sah" };
        }
        let parsed;
        try {
            parsed = new URL(String(snapshotUrl));
        }
        catch {
            return { ok: false, code: "CAMERA_URL_INVALID", reason: "snapshotUrl tidak sah" };
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return { ok: false, code: "CAMERA_URL_INVALID", reason: "snapshotUrl tidak sah" };
        }
        const registered = this._register({
            id, label, location,
            snapshotUrl: parsed.toString(),
            metadata: { ...metadata, deviceId },
            accessClass: CAMERA_ACCESS.AUTHORIZED_DEVICE
        });
        if (registered.ok) {
            registered.camera.trust = Object.freeze({ deviceId, principalId: mint.token.principalId });
        }
        return registered;
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
     * RESTRICTED/UNAVAILABLE selalu ditolak; AUTHORIZED_DEVICE butuh
     * keputusan otorisasi jembatan kanonik (Integrasi 2) — keputusan
     * dihitung dari binding perangkat OwnerTrust pada saat bertanya, jadi
     * revokasi berlaku segera; tidak ada bypass.
     */
    canFetch(id, { authorization = null, cameraAuthorizer = null } = {}) {
        const camera = this.cameras.get(id);
        if (!camera) return { ok: false, reason: "kamera tidak terdaftar" };
        if (camera.cameraAccess !== CAMERA_ACCESS.PUBLIC) {
            if (camera.cameraAccess !== CAMERA_ACCESS.AUTHORIZED_DEVICE) {
                return { ok: false, reason: `akses ${camera.cameraAccess} — fail-closed, tidak ditembus` };
            }
            if (!cameraAuthorizer || typeof cameraAuthorizer.authorizeCameraFrame !== "function") {
                return { ok: false, reason: "akses AUTHORIZED_DEVICE — jembatan trust kanonik tidak terkomposisi (fail-closed)" };
            }
            const verdict = cameraAuthorizer.authorizeCameraFrame({ camera, evidence: authorization });
            if (!verdict.ok) {
                return { ok: false, reason: verdict.reason ?? "otorisasi jembatan ditolak", code: verdict.code };
            }
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

/**
 * Integrasi 2 (post-Lane4): akuisisi frame kamera AUTHORIZED_DEVICE milik
 * pemilik — HANYA lewat jembatan trust kanonik. Alur wajib:
 * otorisasi jembatan (principal Owner/Admin terautentikasi + binding
 * perangkat aktif, revokasi berlaku segera) → batas jaringan kanonik
 * dengan kebijakan trusted-lan (host kamera = satu-satunya allowlist,
 * redirect lintas host ditolak) → bytes bounded → deskriptor inert +
 * ingest MediaIngress kanonik bila terkomposisi.
 * Tanpa jembatan → fail closed (tidak ada akses LAN dari pemanggil arbitrer).
 */
async function acquireAuthorizedCameraFrame(cameraRegistry, cameraId, { authorization = null, cameraAuthorizer = null, mediaIngress = null, maxBytes, timeoutMs } = {}) {
    const verdict = cameraRegistry.canFetch(cameraId, { authorization, cameraAuthorizer });
    if (!verdict.ok) {
        return { ok: false, code: verdict.code ?? "CAMERA_NOT_AUTHORIZED", reason: verdict.reason };
    }
    const camera = verdict.camera;
    const snapshotUrl = camera.metadata?.snapshotUrl;
    const snapshotHost = camera.metadata?.snapshotHost;
    if (!snapshotUrl || !snapshotHost) {
        return { ok: false, code: "CAMERA_SNAPSHOT_MISSING", reason: "kamera tanpa snapshot terdaftar" };
    }

    const { fetchBuffer } = require("../providers/http");
    const bounded = Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.min(maxBytes, MAX_FRAME_BYTES) : MAX_FRAME_BYTES;

    // Kebijakan AUTHORIZED_LOCAL_SOURCE: host terdaftar = satu-satunya
    // allowlist; policy trusted-lan hanya sah di jalur ini (jembatan sudah
    // mengotorisasi), redirect ke host berbeda tetap ditolak.
    let buffer;
    try {
        buffer = await fetchBuffer(snapshotUrl, {
            policy: "trusted-lan",
            allowedHosts: [snapshotHost],
            maxBytes: bounded,
            timeoutMs: timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
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

    const mediaIngest = mediaIngress
        ? await tryIngestViaMediaIngress(mediaIngress, camera, buffer, descriptor)
        : {
            ok: false,
            code: "MEDIA_INGRESS_NOT_COMPOSED",
            reason: "MediaIngress kanonik Damar belum dikomposisi di daemon — (inert, tidak ada link kedua)"
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
    acquireAuthorizedCameraFrame,
    tryIngestViaMediaIngress,
    requiresAuthorization
};