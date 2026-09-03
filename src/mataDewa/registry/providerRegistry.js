/**
 * Spatial Provider Registry — SATU-SATUNYA pintu provider Mata Dewa.
 *
 * Semua provider (keyless maupun berkunci) mencolok ke jahitan observasi
 * ternormalisasi yang sama. Tidak ada logika per-provider yang tersebar di
 * UI/Manager. Kegagalan provider MENURUNKAN kemampuan individual secara
 * jujur — tidak pernah menjadi kegagalan Mata Dewa.
 *
 * Setiap provider mendeklarasikan:
 *   availability, coverage, freshness, quality, accessMode, accessClass,
 *   fallbacks, attribution/license, failureReason
 */

const { PROVIDER_ACCESS_MODE, CREDENTIAL_TIER, isAccessMode, accessModeRequiresCredential } = require("../config");
const { ACCESS_CLASS, canonical: canonicalAccess } = require("../spatial/accessClass");
const { normalizeObservation } = require("../observations/observation");

const PROVIDER_STATE = Object.freeze({
    AVAILABLE: "available",
    DEGRADED: "degraded",
    UNAVAILABLE: "unavailable"
});

let counter = 0;

class ProviderRegistry {

    /**
     * @param {{ clock?: { nowMs(): number }, credentialResolver?: (providerId:string)=>Promise<{ok:boolean, value?:any, code?:string}> }} options
     *   credentialResolver adalah jahitan Secret Vault (commit 8); default
     *   menolak tertutup (fail-closed) sehingga provider berkunci melaporkan
     *   "credentials absent" secara jujur tanpa pernah menembus otorisasi.
     */
    constructor({ clock = { nowMs: () => Date.now() }, credentialResolver = null } = {}) {
        this.clock = clock;
        this.credentialResolver = credentialResolver;
        /** @type {Map<string, object>} */
        this.providers = new Map();
    }

    /**
     * Daftarkan provider. Descriptor:
     * {
     *   id, label, types: [], accessMode, accessClass?, credentialTier?,
     *   coverage?, freshnessMs?, quality?, attribution?, license?,
     *   fallbacks?: [], poll?: async ({ bounds, credential }) => observations[],
     *   healthy?: async () => boolean
     * }
     */
    registerProvider(descriptor = {}) {
        if (!descriptor || typeof descriptor.id !== "string" || !descriptor.id.trim()) {
            throw new TypeError("provider.id wajib berupa string non-kosong");
        }
        const id = descriptor.id.trim();
        if (this.providers.has(id)) {
            throw new Error(`provider '${id}' sudah terdaftar`);
        }
        if (!isAccessMode(descriptor.accessMode)) {
            throw new TypeError(`provider '${id}': accessMode tidak dikenal`);
        }

        const provider = {
            id,
            label: typeof descriptor.label === "string" ? descriptor.label : id,
            types: Object.freeze(Array.isArray(descriptor.types) ? descriptor.types.slice() : []),
            accessMode: descriptor.accessMode,
            accessClass: canonicalAccess(descriptor.accessClass, ACCESS_CLASS.PUBLIC),
            credentialTier: descriptor.credentialTier === CREDENTIAL_TIER.PRO
                ? CREDENTIAL_TIER.PRO : CREDENTIAL_TIER.PLUS,
            requiresCredential: accessModeRequiresCredential(descriptor.accessMode),
            coverage: descriptor.coverage ?? null,
            freshnessMs: Number.isFinite(descriptor.freshnessMs) ? descriptor.freshnessMs : null,
            quality: Number.isFinite(descriptor.quality) ? descriptor.quality : 0.5,
            attribution: descriptor.attribution ?? null,
            license: descriptor.license ?? null,
            fallbacks: Object.freeze(Array.isArray(descriptor.fallbacks) ? descriptor.fallbacks.slice() : []),
            poll: typeof descriptor.poll === "function" ? descriptor.poll : null,
            healthy: typeof descriptor.healthy === "function" ? descriptor.healthy : null,
            // Permukaan on-demand tambahan (mis. computeRoute, reverseGeocode)
            // diteruskan apa adanya agar engine bisa memakainya tanpa menembus
            // registry. Hanya fungsi murni provider, bukan otoritas.
            extras: Object.freeze(Object.fromEntries(
                Object.entries(descriptor)
                    .filter(([k, v]) => typeof v === "function" && k !== "poll" && k !== "healthy")
            )),
            // MD-009: kapabilitas provider yang JUJUR — stub (tanpa poll,
            // tanpa on-demand, tanpa probe) TIDAK PERNAH bisa jadi AVAILABLE.
            capabilities: Object.freeze({
                periodic: typeof descriptor.poll === "function",
                onDemand: Object.entries(descriptor).some(
                    ([k, v]) => typeof v === "function" && k !== "poll" && k !== "healthy"),
                probe: typeof descriptor.healthy === "function"
            }),
            // Keadaan runtime (tidak dibekukan — diperbarui saat poll).
            state: PROVIDER_STATE.UNAVAILABLE,
            failureReason: "not_polled_yet",
            lastPollAt: null,
            lastSuccessAt: null,
            lastProbedAt: null,
            consecutiveFailures: 0
        };

        // Sediakan fungsi on-demand langsung pada objek provider (mis.
        // computeRoute, reverseGeocode) agar engine memakainya lewat satu
        // pintu. MD-009: pemanggilan yang berhasil = BUKTI HIDUP; yang
        // gagal = BUKTI MATI — state provider ikut diperbarui.
        for (const [name, fn] of Object.entries(provider.extras)) {
            provider[name] = async (...args) => {
                try {
                    const result = await fn(...args);
                    this.noteOnDemandSuccess(id);
                    return result;
                }
                catch (error) {
                    this.noteOnDemandFailure(id, error?.message ?? "on_demand_failed");
                    throw error;
                }
            };
        }

        this.providers.set(id, provider);
        return Object.freeze({
            id: provider.id,
            label: provider.label,
            types: provider.types,
            accessMode: provider.accessMode,
            accessClass: provider.accessClass,
            requiresCredential: provider.requiresCredential
        });
    }

    unregisterProvider(id) {
        return this.providers.delete(id);
    }

    getProvider(id) {
        return this.providers.get(id) ?? null;
    }

    listProviders() {
        return [...this.providers.values()].map(p => this.describe(p.id));
    }

    /** Deskripsi jujur ketersediaan sebuah provider untuk UI/Manager. */
    describe(id) {
        const p = this.providers.get(id);
        if (!p) return null;
        // MD-009: ketersediaan EFEKTIF — AVAILABLE yang sudah basi (sukses
        // terakhir jauh melampaui jendela kesegaran) dilaporkan DEGRADED
        // dengan penanda stale; state mentah tetap diekspos untuk audit.
        const stale = this.isStale(id);
        const availability = (p.state === PROVIDER_STATE.AVAILABLE && stale)
            ? PROVIDER_STATE.DEGRADED
            : p.state;
        return {
            id: p.id,
            label: p.label,
            types: p.types,
            accessMode: p.accessMode,
            accessClass: p.accessClass,
            requiresCredential: p.requiresCredential,
            credentialTier: p.requiresCredential ? p.credentialTier : null,
            availability,
            stale,
            capabilities: p.capabilities,
            failureReason: availability === PROVIDER_STATE.AVAILABLE
                ? null
                : (p.failureReason ?? (stale ? "success_stale" : null)),
            coverage: p.coverage,
            freshnessMs: p.freshnessMs,
            quality: p.quality,
            attribution: p.attribution,
            license: p.license,
            fallbacks: p.fallbacks,
            lastPollAt: p.lastPollAt,
            lastSuccessAt: p.lastSuccessAt,
            lastProbedAt: p.lastProbedAt,
            consecutiveFailures: p.consecutiveFailures
        };
    }

    async _resolveCredential(p) {
        if (!p.requiresCredential) return { ok: true, value: null };
        if (!this.credentialResolver) {
            return { ok: false, code: "credentials_absent" };
        }
        try {
            const result = await this.credentialResolver(p.id);
            if (result?.ok) return { ok: true, value: result.value ?? null };
            return { ok: false, code: result?.code ?? "credentials_absent" };
        }
        catch {
            return { ok: false, code: "credential_resolution_failed" };
        }
    }

    /**
     * MD-009: probe jujur satu provider (on-demand / stub).
     *  - Stub (tanpa poll, tanpa on-demand, tanpa probe) → TIDAK PERNAH
     *    AVAILABLE; alasan eksplisit "not_implemented".
     *  - Ada hook healthy() → jalankan; hasilnya menentukan state.
     *  - On-demand tanpa hook → tetap UNAVAILABLE "not_proven_yet"
     *    sampai pemanggilan on-demand pertama yang berhasil (lihat
     *    noteOnDemandSuccess).
     * TIDAK PERNAH melempar.
     */
    async probeProvider(id) {
        const p = this.providers.get(id);
        const nowMs = this.clock.nowMs();
        if (!p) {
            return { ok: false, providerId: id, state: PROVIDER_STATE.UNAVAILABLE, failureReason: "unknown_provider" };
        }
        p.lastProbedAt = nowMs;
        if (!p.capabilities.periodic && !p.capabilities.onDemand && !p.capabilities.probe) {
            p.state = PROVIDER_STATE.UNAVAILABLE;
            p.failureReason = "not_implemented";
            return { ok: false, providerId: id, state: p.state, failureReason: p.failureReason };
        }
        if (p.capabilities.probe) {
            try {
                const verdict = await p.healthy();
                if (verdict === true) {
                    p.state = PROVIDER_STATE.AVAILABLE;
                    p.failureReason = null;
                    p.lastSuccessAt = p.lastSuccessAt ?? nowMs;
                    return { ok: true, providerId: id, state: p.state, failureReason: null };
                }
                p.state = PROVIDER_STATE.UNAVAILABLE;
                p.failureReason = "health_probe_failed";
                return { ok: false, providerId: id, state: p.state, failureReason: p.failureReason };
            }
            catch {
                p.state = PROVIDER_STATE.UNAVAILABLE;
                p.failureReason = "health_probe_failed";
                return { ok: false, providerId: id, state: p.state, failureReason: p.failureReason };
            }
        }
        // On-demand tanpa hook probe: belum terbukti.
        if (p.state !== PROVIDER_STATE.AVAILABLE) {
            p.state = PROVIDER_STATE.UNAVAILABLE;
            p.failureReason = "not_proven_yet";
        }
        return { ok: false, providerId: id, state: p.state, failureReason: p.failureReason };
    }

    /** MD-009: on-demand sukses pertama = bukti hidup yang sah. */
    noteOnDemandSuccess(id, nowMs = this.clock.nowMs()) {
        const p = this.providers.get(id);
        if (!p) return false;
        if (!p.capabilities.onDemand) return false;
        p.state = PROVIDER_STATE.AVAILABLE;
        p.failureReason = null;
        p.lastSuccessAt = nowMs;
        return true;
    }

    /** MD-009: on-demand gagal = bukti mati yang sah. */
    noteOnDemandFailure(id, reason = "on_demand_failed", nowMs = this.clock.nowMs()) {
        const p = this.providers.get(id);
        if (!p) return false;
        if (!p.capabilities.onDemand) return false;
        p.consecutiveFailures += 1;
        p.state = p.consecutiveFailures >= 2 ? PROVIDER_STATE.UNAVAILABLE : PROVIDER_STATE.DEGRADED;
        p.failureReason = String(reason).slice(0, 200);
        return true;
    }

    /** MD-009: apakah sukses terakhir provider sudah basi (stale)? */
    isStale(id, { maxStalenessMs = null } = {}) {
        const p = this.providers.get(id);
        if (!p) return false;
        if (p.state !== PROVIDER_STATE.AVAILABLE) return false;
        if (p.lastSuccessAt === null) return false;
        const window = Number.isFinite(maxStalenessMs)
            ? maxStalenessMs
            : Math.max((p.freshnessMs ?? 0) * 10, 30 * 60 * 1000);
        return (this.clock.nowMs() - p.lastSuccessAt) > window;
    }

    /**
     * Poll satu provider; normalisasi hasilnya ke SpatialObservation.
     * Mengembalikan { ok, providerId, state, observations, failureReason }.
     * TIDAK PERNAH melempar — kegagalan provider ditangkap dan dilaporkan.
     */
    async pollProvider(id, { bounds = null } = {}) {
        const p = this.providers.get(id);
        const nowMs = this.clock.nowMs();
        if (!p) {
            return { ok: false, providerId: id, state: PROVIDER_STATE.UNAVAILABLE, observations: [], failureReason: "unknown_provider" };
        }
        // MD-009: stub jujur TIDAK PERNAH AVAILABLE — alasan eksplisit.
        if (!p.capabilities.periodic && !p.capabilities.onDemand && !p.capabilities.probe) {
            p.state = PROVIDER_STATE.UNAVAILABLE;
            p.failureReason = "not_implemented";
            p.lastPollAt = nowMs;
            return { ok: false, providerId: id, state: p.state, observations: [], failureReason: p.failureReason };
        }
        if (typeof p.poll !== "function") {
            // Provider on-demand (mis. routing/geocode) tanpa feed periodik:
            // TIDAK ditandai AVAILABLE tanpa bukti — probe/hasil on-demand
            // pertama yang membuktikan (MD-009).
            return this.probeProvider(id).then((probe) => ({
                ok: probe.ok,
                providerId: id,
                state: probe.state,
                observations: [],
                failureReason: probe.failureReason,
                onDemand: true
            }));
        }

        const credential = await this._resolveCredential(p);
        if (!credential.ok) {
            p.state = PROVIDER_STATE.UNAVAILABLE;
            p.failureReason = credential.code;
            p.lastPollAt = nowMs;
            return { ok: false, providerId: id, state: p.state, observations: [], failureReason: p.failureReason };
        }

        // MD-009: probe kesehatan (bila ada) MENGEREMI poll — provider
        // dengan health check gagal TIDAK ditandai AVAILABLE walau poll
        // kebetulan berhasil (kepercayaan mengikuti bukti terburuk).
        if (p.capabilities.probe) {
            const probe = await this.probeProvider(id);
            if (!probe.ok) {
                p.lastPollAt = nowMs;
                return { ok: false, providerId: id, state: probe.state, observations: [], failureReason: probe.failureReason };
            }
        }

        try {
            const raw = await p.poll({ bounds, credential: credential.value });
            const list = Array.isArray(raw) ? raw : [];
            const observations = [];
            for (const item of list) {
                const normalized = normalizeObservation(
                    { ...item, source: item?.source ?? p.id },
                    { nowMs }
                );
                if (normalized.ok) observations.push(normalized.observation);
            }
            p.state = PROVIDER_STATE.AVAILABLE;
            p.failureReason = null;
            p.lastPollAt = nowMs;
            p.lastSuccessAt = nowMs;
            p.consecutiveFailures = 0;
            return { ok: true, providerId: id, state: p.state, observations, failureReason: null };
        }
        catch (error) {
            p.consecutiveFailures += 1;
            p.lastPollAt = nowMs;
            // Kegagalan berulang menurunkan provider; kegagalan tunggal = degraded.
            p.state = p.consecutiveFailures >= 2 ? PROVIDER_STATE.UNAVAILABLE : PROVIDER_STATE.DEGRADED;
            p.failureReason = (error && error.message) ? String(error.message).slice(0, 200) : "poll_failed";
            return { ok: false, providerId: id, state: p.state, observations: [], failureReason: p.failureReason };
        }
    }

    /**
     * Poll semua provider yang menyediakan salah satu tipe diminta.
     * Gagal satu provider tidak menghentikan yang lain (Promise settled).
     */
    async pollTypes(types, { bounds = null } = {}) {
        const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
        const targets = [...this.providers.values()].filter(p =>
            !wanted || p.types.some(t => wanted.has(t))
        );
        const results = await Promise.allSettled(
            targets.map(p => this.pollProvider(p.id, { bounds }))
        );
        const observations = [];
        const statuses = [];
        for (const settled of results) {
            const r = settled.status === "fulfilled" ? settled.value : {
                ok: false, providerId: "unknown", state: PROVIDER_STATE.UNAVAILABLE,
                observations: [], failureReason: String(settled.reason ?? "poll_rejected")
            };
            observations.push(...r.observations);
            statuses.push({
                providerId: r.providerId,
                state: r.state,
                observationCount: r.observations.length,
                failureReason: r.failureReason
            });
        }
        return { observations, statuses };
    }

    get size() { return this.providers.size; }
}

module.exports = { ProviderRegistry, PROVIDER_STATE };
