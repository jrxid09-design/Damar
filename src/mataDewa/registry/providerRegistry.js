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
            // Keadaan runtime (tidak dibekukan — diperbarui saat poll).
            state: PROVIDER_STATE.UNAVAILABLE,
            failureReason: "not_polled_yet",
            lastPollAt: null,
            lastSuccessAt: null,
            consecutiveFailures: 0
        };

        // Sediakan fungsi on-demand langsung pada objek provider (mis.
        // computeRoute, reverseGeocode) agar engine memakainya lewat satu pintu.
        for (const [name, fn] of Object.entries(provider.extras)) {
            provider[name] = fn;
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
        return {
            id: p.id,
            label: p.label,
            types: p.types,
            accessMode: p.accessMode,
            accessClass: p.accessClass,
            requiresCredential: p.requiresCredential,
            credentialTier: p.requiresCredential ? p.credentialTier : null,
            availability: p.state,
            failureReason: p.state === PROVIDER_STATE.AVAILABLE ? null : p.failureReason,
            coverage: p.coverage,
            freshnessMs: p.freshnessMs,
            quality: p.quality,
            attribution: p.attribution,
            license: p.license,
            fallbacks: p.fallbacks,
            lastPollAt: p.lastPollAt,
            lastSuccessAt: p.lastSuccessAt,
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
        if (typeof p.poll !== "function") {
            // Provider on-demand (mis. routing/geocode) tanpa feed periodik:
            // tersedia atas permintaan, tidak menghasilkan observasi periodik.
            p.state = PROVIDER_STATE.AVAILABLE;
            p.failureReason = null;
            return { ok: true, providerId: id, state: p.state, observations: [], failureReason: null, onDemand: true };
        }

        const credential = await this._resolveCredential(p);
        if (!credential.ok) {
            p.state = PROVIDER_STATE.UNAVAILABLE;
            p.failureReason = credential.code;
            p.lastPollAt = nowMs;
            return { ok: false, providerId: id, state: p.state, observations: [], failureReason: p.failureReason };
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
