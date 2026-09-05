"use strict";

/**
 * JEMBATAN TRUST KANONIK MATA DEWA (Lane 5 integrasi post-Lane4) — modul
 * sempit yang menyatukan Lane 4 tersertifikasi dengan Mata Dewa.
 *
 * OWNS (satu-satunya tempat penyambungan):
 *   - cameraAuthorizer  : otorisasi kamera AUTHORIZED_DEVICE dari binding
 *                         perangkat OwnerTrust KANONIK (bukan string
 *                         pemanggil) + Admin yang didelegasikan sah.
 *   - rfDeviceTrustGate : gerbang eskalasi produksi-live RF (Integrasi 3).
 *   - audit             : sink audit mataDewa.* (Integrasi 6) — appendSafe
 *                         ke ledger tersertifikasi; gagal → { ok:false }.
 *   - vault             : Secret Vault kanonik untuk kredensial provider
 *                         (Integrasi 1) — cipher AMAN wajib di produksi.
 *   - mediaIngress      : MediaIngress kanonik Damar untuk ingest frame
 *                         CCTV (Integrasi 2) — opsional; bila tidak ada,
 *                         acquire melapor jujur MEDIA_INGRESS_NOT_COMPOSED.
 *
 * HUKUM:
 *   - Tidak ada perubahan semantik modul Lane 4. Jembatan HANYA MEMBACA
 *     registry/binders/ledger yang tersertifikasi.
 *   - Otorisasi kamera TIDAK PERNAH lahir dari string pemanggil: token
 *     otorisasi hanyalah keputusan yang dihitung dari binding kanonik.
 *   - Device trust ≠ Owner. Otorisasi kamera butuh principal terautentikasi
 *     dari bridge tersertifikasi (Owner atau Admin AKTIF).
 *   - FAIL CLOSED: komposisi tanpa jembatan → semua permukaan berotorisasi
 *     tetap menolak (OWNER_TRUST_NOT_INTEGRATED) seperti pra-integrasi.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createRfDeviceTrustGate } = require("./rfDeviceTrust");
const { createProductionCipherAdapter } = require("../../runtime/vaultProviders");
const { verifyTransportPeerProvenance } = require("../../authority/ownerTrust/provenance");
const { isCanonicalOwnerTrustComposition } = require("../../authority/ownerTrustComposition");

/** MD-018: objek bridges TERSERTIFIKASI — hanya buildMataDewaTrustBridges. */
const canonicalBridgeInstances = new WeakSet();

const CAMERA_AUTHZ_KIND = "mata-dewa.camera.authorization.v1";

function isNonEmptyString(v, max = 256) {
    return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** Tidak ada materi kredensial/secretref yang boleh keluar dalam audit. */
function sanitizeAuditMetadata(metadata) {
    if (metadata === null || metadata === undefined) return null;
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (/credential|secret|token|password|key|ref/i.test(key)) continue;
        if (typeof value === "string" && value.length > 256) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
            out[key] = value;
        }
    }
    return Object.freeze(out);
}

/**
 * Authorizer kamera dari trust kanonik. Keputusan dihitung DARI registry
 * OwnerTrust pada saat bertanya (tidak ada cache keputusan positif):
 *   - principal Owner/Admin AKTIF (authVerifier kanonik / binding kanal),
 *   - binding perangkat aktif kind "device" untuk deviceId kamera,
 *   - principalId binding = principal terautentikasi.
 */
function createCctvAuthorizer({ registry, authVerifier, channelBinders = null, audit } = {}) {
    if (!registry || typeof registry.findBinding !== "function" ||
        typeof registry.principalState !== "function") {
        throw new TypeError("CAMERA_AUTHORIZER_INVALID: registry OwnerTrust kanonik wajib ada");
    }
    if (typeof authVerifier !== "function") {
        throw new TypeError("CAMERA_AUTHORIZER_INVALID: authVerifier kanonik wajib ada");
    }
    if (channelBinders !== null && typeof channelBinders !== "object") {
        throw new TypeError("CAMERA_AUTHORIZER_INVALID: channelBinders kanonik wajib objek/null");
    }

    function deviceBindingActive(deviceId) {
        if (!isNonEmptyString(deviceId, 128)) return null;
        const binding = registry.findBinding({ kind: "device", peer: `device:${deviceId}` });
        if (!binding) return null;
        if (registry.principalState(binding.principalId) !== "ACTIVE") return null;
        const principal = typeof registry.getPrincipal === "function"
            ? registry.getPrincipal(binding.principalId) : null;
        if (principal && typeof principal.generation === "number" &&
            binding.generation < principal.generation) {
            return null; // binding basi pasca rotasi/revokasi kredensial
        }
        return binding;
    }

    /**
     * Autentikasi principal dari evidence kanonik. Menerima:
     *   - { proof }       → bukti kepemilikan Owner/Admin (authVerifier)
     *   - { provenance }  → bukti transport peer KANONIK (di-mint oleh
     *     ingress adapter tersertifikasi, bukan payload pemanggil).
     *     Verdict dihitung oleh BINDER kanal tersertifikasi — pemanggil
     *     tidak pernah menyumbang principalId/kanal (MD-020): klaim
     *     "saya Owner via console" dari pemanggil tidak ada di kontrak.
     * Mengembalikan { ok, principalId, role } atau { ok:false, reason }.
     */
    function authenticate(evidence = {}) {
        if (!evidence || typeof evidence !== "object") {
            return { ok: false, reason: "evidence otorisasi tidak sah" };
        }
        if (evidence.proof && typeof evidence.proof === "object") {
            const result = authVerifier(evidence.proof);
            if (!result || !result.principal) {
                return { ok: false, reason: "proof Owner/Admin ditolak" };
            }
            const state = registry.principalState(result.principal);
            if (state !== "ACTIVE") {
                return { ok: false, reason: `principal ${state}` };
            }
            const owner = registry.getOwner();
            const role = owner && owner.principalId === result.principal ? "owner" : "admin";
            return { ok: true, principalId: result.principal, role };
        }
        // MD-020: evidence kanal = canonical TransportPeerProvenance yang
        // diverifikasi binder tersertifikasi. Klaim principalId/kanal dari
        // pemanggil TIDAK dipertimbangkan (tidak ada viaChannel).
        const view = verifyTransportPeerProvenance(evidence.provenance);
        if (!view) {
            return { ok: false, reason: "provenance transport tidak kanonik" };
        }
        const binder = channelBinders?.[view.transport];
        if (!binder || typeof binder.authenticate !== "function") {
            return { ok: false, reason: `kanal ${view.transport} tidak tersertifikasi` };
        }
        const verdict = binder.authenticate({ provenance: evidence.provenance });
        if (!verdict || verdict.ok !== true || typeof verdict.principalId !== "string") {
            return { ok: false, reason: `kanal ${view.transport}: ${verdict?.code ?? "OT_AUTH_FAILED"}` };
        }
        const principalId = verdict.principalId;
        const state = registry.principalState(principalId);
        if (state !== "ACTIVE") {
            return { ok: false, reason: `principal ${state}` };
        }
        const owner = registry.getOwner();
        const role = owner && owner.principalId === principalId ? "owner" : "admin";
        if (role !== "owner" && role !== "admin") {
            return { ok: false, reason: "principal bukan Owner/Admin" };
        }
        return { ok: true, principalId, role };
    }

    /**
     * Otorisasi frame kamera AUTHORIZED_DEVICE.
     * @param {{ camera, evidence }} params
     * @returns {{ ok, principalId?, role?, code?, reason? }}
     */
    function authorizeCameraFrame({ camera, evidence } = {}) {
        if (!camera || camera.cameraAccess !== "AUTHORIZED_DEVICE") {
            return { ok: false, code: "CAMERA_NOT_AUTHORIZED_DEVICE", reason: "kamera bukan AUTHORIZED_DEVICE" };
        }
        const auth = authenticate(evidence);
        if (!auth.ok) {
            return { ok: false, code: "PRINCIPAL_NOT_AUTHENTICATED", reason: auth.reason };
        }
        const deviceId = camera.trust?.deviceId;
        const binding = deviceBindingActive(deviceId);
        if (!binding) {
            return { ok: false, code: "CAMERA_DEVICE_BINDING_INVALID", reason: "binding perangkat kamera tidak aktif/valid" };
        }
        if (binding.principalId !== auth.principalId) {
            return { ok: false, code: "CAMERA_NOT_OWNED_BY_PRINCIPAL", reason: "kamera bukan milik principal ini" };
        }
        const verdict = emitAudit({
            eventType: "matadewa.camera.authorized",
            actor: { kind: "user", id: auth.principalId },
            subject: { kind: "device", id: camera.id },
            outcome: "ok",
            metadata: { deviceId, role: auth.role }
        });
        if (!verdict.ok) {
            return { ok: false, code: "AUDIT_UNAVAILABLE", reason: "audit gagal — otorisasi ditolak (fail closed)" };
        }
        return { ok: true, principalId: auth.principalId, role: auth.role };
    }

    function emitAudit(input) {
        if (!audit) return { ok: true };
        try {
            const result = audit({ ...input, source: "matadewa.trust", metadata: sanitizeAuditMetadata(input.metadata) });
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
     * Registrasi kamera AUTHORIZED_DEVICE HANYA lewat jembatan: butuh
     * principal Owner/Admin terautentikasi + binding perangkat aktif untuk
     * deviceId. Mengembalikan token otorisasi SEALED (branded WeakSet) yang
     * SAH untuk kamera+deviceId ini — bukan string yang bisa dipalsukan.
     */
    const sealedTokens = new WeakSet();
    function mintCameraRegistrationToken({ evidence, deviceId } = {}) {
        const auth = authenticate(evidence);
        if (!auth.ok) return { ok: false, code: "PRINCIPAL_NOT_AUTHENTICATED", reason: auth.reason };
        const binding = deviceBindingActive(deviceId);
        if (!binding || binding.principalId !== auth.principalId) {
            return { ok: false, code: "CAMERA_DEVICE_BINDING_INVALID", reason: "binding perangkat tidak aktif untuk principal ini" };
        }
        const verdict = emitAudit({
            eventType: "matadewa.camera.registration",
            actor: { kind: "user", id: auth.principalId },
            subject: { kind: "device", id: deviceId },
            outcome: "ok",
            metadata: { role: auth.role }
        });
        if (!verdict.ok) {
            return { ok: false, code: verdict.code, reason: "audit gagal — registrasi ditolak (fail closed)" };
        }
        const token = { kind: CAMERA_AUTHZ_KIND, deviceId, principalId: auth.principalId, mintedAtMs: Date.now() };
        sealedTokens.add(token);
        return { ok: true, token };
    }

    function verifySealedToken(token, deviceId) {
        if (!token || typeof token !== "object" || token.kind !== CAMERA_AUTHZ_KIND) return false;
        if (!sealedTokens.has(token)) return false;
        return token.deviceId === deviceId;
    }

    return Object.freeze({
        authenticate,
        authorizeCameraFrame,
        mintCameraRegistrationToken,
        verifySealedToken,
        deviceBindingActive
    });
}

/**
 * Sink audit Mata Dewa di atas ledger tersertifikasi. appendSafe; kegagalan
 * dilaporkan jujur ke pemanggil mutasi (fail closed) — tidak pernah melempar.
 */
function createMataDewaAuditSink({ ledger } = {}) {
    if (!ledger || typeof ledger.appendSafe !== "function") {
        throw new TypeError("MATA_DEWA_AUDIT_INVALID: ledger tersertifikasi wajib ada");
    }
    return function audit({ eventType, source = "matadewa.trust", actor, subject, outcome, metadata }) {
        try {
            const result = ledger.appendSafe({
                eventType,
                source,
                actor,
                subject,
                outcome,
                metadata: sanitizeAuditMetadata(metadata)
            });
            if (result && typeof result === "object" && result.ok === false) {
                return { ok: false, code: result.code ?? "AUDIT_REJECTED" };
            }
            return { ok: true };
        }
        catch {
            return { ok: false, code: "AUDIT_UNAVAILABLE" };
        }
    };
}

/**
 * Susun SEMUA gerbang trust dari komposisi OwnerTrust tersertifikasi.
 * @param {object} comp  hasil composeOwnerTrustForTest/ensureCanonicalComposed
 * @param {object} [opts] { vault, mediaIngress } — vault eksplisit dipakai
 *   komposisi root produksi; bila tidak diberikan, vault komposisi dipakai.
 */
function buildMataDewaTrustBridges(comp, { vault, mediaIngress = null, clock = { nowMs: () => Date.now() } } = {}) {
    // MD-018: authority source must be the certified composition itself.
    // A duck-typed lookalike ({ ...comp, registry: forged }) is rejected
    // here — the WeakSet brand (lexical to ownerTrustComposition) is
    // unforgeable by construction, and no importable function can mint it.
    if (!isCanonicalOwnerTrustComposition(comp)) {
        throw new TypeError("TRUST_BRIDGES_INVALID: komposisi OwnerTrust kanonik (ter-brand) wajib ada");
    }
    const audit = comp.ledger ? createMataDewaAuditSink({ ledger: comp.ledger }) : null;
    const cameraAuthorizer = createCctvAuthorizer({
        registry: comp.registry,
        authVerifier: comp.authVerifier,
        channelBinders: comp.channelBinders ?? null,
        audit
    });
    const rfDeviceTrustGate = createRfDeviceTrustGate({
        registry: comp.registry,
        clock,
        audit
    });
    const bridges = Object.freeze({
        registry: comp.registry,
        authVerifier: comp.authVerifier,
        vault: vault !== undefined ? vault : (comp.vault ?? null),
        ledger: comp.ledger ?? null,
        audit,
        cameraAuthorizer,
        rfDeviceTrustGate,
        mediaIngress
    });
    // MD-018: bridges yang lahir dari pabrik ini saja yang boleh menempel
    // ke service (attach memverifikasi brand; objek tiruan ditolak).
    canonicalBridgeInstances.add(bridges);
    return bridges;
}

/**
 * Lampirkan bridges ke service Mata Dewa (dipanggil sekali dari komposisi).
 * Vault disambungkan ke credential store (Integrasi 1) dengan fail-closed
 * bila cipher tidak aman di produksi.
 *
 * MD-019: permukaan kontrol RF TERISTIMEWA lahir DI SINI — di dalam
 * closure modul jembatan, bukan sebagai properti service (enumerable
 * maupun tidak). Pemanggil arbitrer tidak bisa mengintip/meniru service
 * untuk mendapatkannya; satu-satunya jalan produksi tetap Action Intent →
 * Authority kanonik → Actuation Fabric → actuator → resolusi leksikal.
 * Permukaan di-cache per-service (WeakMap) agar state listener live
 * (enable/disable/revoke) persisten antar invoke actuator.
 */
const rfControlSurfacesByService = new WeakMap();

function attachMataDewaTrustBridges(service, bridges) {
    if (!service || typeof service !== "object" || !service.credentialStore) {
        throw new TypeError("ATTACH_TRUST_INVALID: service Mata Dewa wajib ada");
    }
    if (!canonicalBridgeInstances.has(bridges)) {
        throw new TypeError("ATTACH_TRUST_INVALID: bridges bukan hasil buildMataDewaTrustBridges kanonik (MD-018)");
    }
    if (bridges.vault) {
        const attach = typeof service.credentialStore.attachVault === "function"
            ? service.credentialStore.attachVault(bridges.vault)
            : { ok: false, code: "VAULT_ATTACH_UNSUPPORTED" };
        if (!attach.ok) {
            throw Object.assign(new Error(`MATA_DEWA_VAULT_BIND_FAILED: ${attach.code ?? attach.reason ?? "unknown"}`),
                { code: "MATA_DEWA_VAULT_BIND_FAILED" });
        }
    }
    const { createRfControlSurface } = require("./rfControlSurface");
    const rfControl = createRfControlSurface({
        service,
        gateAccessor: () => bridges.rfDeviceTrustGate ?? null,
        auditAccessor: () => bridges.audit ?? null,
        allowLocalUdp: service._allowLocalUdp === true
    });
    rfControlSurfacesByService.set(service, Object.freeze(rfControl));
    Object.defineProperty(service, "_trustBridges", {
        value: Object.freeze(bridges),
        enumerable: false,
        writable: false,
        configurable: false
    });
    return service;
}

/**
 * MD-019: resolusi LEXICAL permukaan kontrol RF untuk actuator Action
 * Fabric. Hanya service yang pernah menerima attach trust kanonik punya
 * permukaan; tanpa itu → null (fail-closed di actuator). Tidak ada jalur
 * pembuatan on-demand: permukaan tidak pernah bisa di-mint dari service
 * kosong.
 */
function resolveMataDewaRfControlSurface(service) {
    return rfControlSurfacesByService.get(service) ?? null;
}

module.exports = Object.freeze({
    buildMataDewaTrustBridges,
    attachMataDewaTrustBridges,
    resolveMataDewaRfControlSurface,
    createCctvAuthorizer,
    createMataDewaAuditSink,
    sanitizeAuditMetadata,
    CAMERA_AUTHZ_KIND
});
