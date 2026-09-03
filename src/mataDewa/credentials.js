/**
 * Kredensial provider Mata Dewa — SATU jahitan ke Secret Vault kanonik Damar.
 *
 * HUKUM:
 *  - Tidak ada secret store kedua. Mata Dewa adalah konsumen kanonik pertama
 *    vault; konfigurasi hanya menyimpan string SecretRef (secretref:v1:...),
 *    tidak pernah cleartext.
 *  - Kredensial TIDAK di-commit. Jalur konfigurasi lokal: data/mataDewa/
 *    (di-ignore) atau env untuk pewarisan.
 *  - CREDENTIAL AVAILABILITY ≠ CORE AVAILABILITY: tanpa kredensial, provider
 *    berkunci melaporkan "credentials absent" secara jujur — tidak pernah
 *    menembus autentikasi provider.
 *  - SECRETS != AUTHORITY: punya kredensial tidak memberi otoritas apa pun.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createSecretVault, refs, scope, redact } = require("../runtime/vault");
const { CREDENTIAL_TIER, PROVIDER_ACCESS_MODE } = require("./config");

const SCOPE = Object.freeze({ kind: "provider", key: "matadewa" });

/**
 * Registry kredensial — providerId → SecretRef string.
 * Persisten di jalur lokal yang di-ignore (data/mataDewa/credentials.json);
 * fallback memori untuk tes.
 */
class MataDewaCredentialStore {

    /**
     * @param {{ vault?: object, filePath?: string|null }} options
     *   vault: instance Secret Vault Damar (createSecretVault).
     *   filePath: null → hanya memori (tes/default aman).
     */
    constructor({ vault = null, filePath = null } = {}) {
        this.vault = vault ?? createSecretVault({ now: () => Date.now() });
        this.filePath = filePath;
        /** @type {Map<string, string>} providerId → secretref string */
        this.refs = new Map();
        if (filePath && fs.existsSync(filePath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
                for (const [id, ref] of Object.entries(parsed?.refs ?? {})) {
                    if (typeof ref === "string" && ref.startsWith("secretref:v1:")) {
                        this.refs.set(id, ref);
                    }
                }
            }
            catch {
                // Konfigurasi korup → mulai kosong; jangan crash Damar.
            }
        }
    }

    /**
     * Simpan kredensial provider ke vault + simpan referensinya.
     * @returns {{ ok, refString?, reason? }}
     */
    setCredential(providerId, value, { label = null } = {}) {
        if (!providerId || typeof value !== "string" || !value.trim()) {
            return { ok: false, reason: "providerId + value wajib" };
        }
        const created = this.vault.create({
            scope: SCOPE,
            label: label ?? `matadewa:${providerId}`,
            value: value.trim()
        });
        const refString = refs.secretRefToString(created.ref);
        this.refs.set(providerId, refString);
        this._persist();
        return { ok: true, refString };
    }

    /** Hapus kredensial (revoke di vault + hapus ref). */
    removeCredential(providerId) {
        const refString = this.refs.get(providerId);
        if (!refString) return { ok: false, reason: "tidak ada kredensial untuk provider ini" };
        try {
            this.vault.revoke(refString);
        }
        catch { /* revoke best-effort */ }
        this.refs.delete(providerId);
        this._persist();
        return { ok: true };
    }

    hasCredential(providerId) {
        return this.refs.has(providerId);
    }

    listProviderIds() {
        return [...this.refs.keys()];
    }

    /**
     * Resolver untuk ProviderRegistry (jahitan credentialResolver).
     * Gagal = { ok:false, code:"credentials_absent" } — jujur, tanpa bypass.
     */
    resolveCredential = async (providerId) => {
        const refString = this.refs.get(providerId);
        if (!refString) return { ok: false, code: "credentials_absent" };
        try {
            // resolveIn menerima string SecretRef dan menegakkan scope.
            const resolved = this.vault.resolveIn(SCOPE, refString);
            if (!resolved.ok) return { ok: false, code: "credential_unresolvable" };
            // Nilai hanya hidup di memori pemanggil sesaat; tidak pernah di-log.
            return { ok: true, value: resolved.value.reveal() };
        }
        catch {
            return { ok: false, code: "credential_resolution_failed" };
        }
    };

    /** Perkiraan mode ketersediaan (ZERO/PLUS/PRO) dari kredensial terpasang. */
    availabilityMode(providerDescriptors) {
        let mode = "ZERO";
        for (const descriptor of providerDescriptors) {
            if (!descriptor.requiresCredential) continue;
            if (!this.hasCredential(descriptor.id)) continue;
            if (descriptor.credentialTier === CREDENTIAL_TIER.PRO) return "PRO";
            mode = "PLUS";
        }
        return mode;
    }

    _persist() {
        if (!this.filePath) return;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const payload = { schemaVersion: 1, refs: Object.fromEntries(this.refs) };
            fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
        }
        catch { /* persist best-effort; vault tetap sumber kebenaran */ }
    }
}

/** Deskriptor provider opsional berkunci (PLUS/PRO) untuk registrasi. */
const OPTIONAL_PROVIDER_CREDENTIALS = Object.freeze({
    // PLUS — akun gratis/milik pengguna
    "opensky-network": { tier: CREDENTIAL_TIER.PLUS, accessMode: PROVIDER_ACCESS_MODE.OAUTH, fields: ["client_id", "client_secret"] },
    "aisstream": { tier: CREDENTIAL_TIER.PLUS, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["api_key"] },
    "firms": { tier: CREDENTIAL_TIER.PLUS, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["map_key"] },
    "bmkg": { tier: CREDENTIAL_TIER.PLUS, accessMode: PROVIDER_ACCESS_MODE.PUBLIC_ACCOUNT, fields: ["token"] },
    // PRO — komersial opsional
    "tomtom": { tier: CREDENTIAL_TIER.PRO, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["api_key"] },
    "google-maps": { tier: CREDENTIAL_TIER.PRO, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["api_key"] },
    "cesium-ion": { tier: CREDENTIAL_TIER.PRO, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["token"] },
    "vaisala-xweather": { tier: CREDENTIAL_TIER.PRO, accessMode: PROVIDER_ACCESS_MODE.API_KEY, fields: ["client_id", "client_secret"] }
});

module.exports = {
    MataDewaCredentialStore,
    OPTIONAL_PROVIDER_CREDENTIALS,
    CREDENTIAL_SCOPE: SCOPE
};
