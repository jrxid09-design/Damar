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
 *
 * MD-007 FAIL CLOSED PRA-INTEGRASI:
 *  - Penyimpanan kredensial HANYA lewat Secret Vault kanonik yang
 *    DIKOMPOSISI EKSPLISIT oleh trusted composition. Tanpa komposisi
 *    eksplisit, setCredential/removeCredential/resolveCredential MENOLAK
 *    dengan VAULT_NOT_COMPOSED — tidak ada vault uji internal yang
 *    diam-diam dipakai menyimpan kredensial pemilik.
 *  - Vault yang terkomposisi dengan cipher TIDAK AMAN (mis. adapter uji
 *    deterministik) juga DITOLAK (VAULT_CIPHER_NOT_SECURE): kredensial
 *    nyata tidak pernah disimpan di vault yang jujur menyatakan dirinya
 *    mudah didekode siapa pun dengan akses file.
 *  - providerId divalidasi terhadap skema kredensial Mata Dewa.
 */
class MataDewaCredentialStore {

    /**
     * @param {{ vault?: object, filePath?: string|null }} options
     *   vault: instance Secret Vault Damar (createSecretVault) — WAJIB
     *   eksplisit dari trusted composition; tanpa ini store fail-closed.
     *   filePath: null → hanya memori (tes/default aman).
     */
    constructor({ vault = null, filePath = null } = {}) {
        // MD-007: hanya vault yang diberikan EKSPLISIT yang boleh dipakai.
        this.vaultExplicit = vault !== null && vault !== undefined;
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

    /** MD-007: vault terkomposisi eksplisit DAN cipher-nya aman? */
    _vaultReady() {
        if (!this.vaultExplicit) {
            return { ok: false, code: "VAULT_NOT_COMPOSED" };
        }
        try {
            const cipher = this.vault.stats?.().cipher;
            if (cipher && cipher.secure === false) {
                return { ok: false, code: "VAULT_CIPHER_NOT_SECURE" };
            }
        }
        catch {
            return { ok: false, code: "VAULT_CIPHER_NOT_SECURE" };
        }
        return { ok: true };
    }

    /**
     * Simpan kredensial provider ke vault + simpan referensinya.
     * FAIL CLOSED pra-integrasi (MD-007): tanpa vault kanonik terkomposisi
     * eksplisit, atau dengan cipher tidak aman → ditolak dengan kode jujur.
     * @returns {{ ok, refString?, reason?, code? }}
     */
    setCredential(providerId, value, { label = null } = {}) {
        const readiness = this._vaultReady();
        if (!readiness.ok) {
            return {
                ok: false,
                code: readiness.code,
                reason: readiness.code === "VAULT_NOT_COMPOSED"
                    ? "Secret Vault kanonik tidak terkomposisi (trusted composition) — " +
                        "penyimpanan kredensial fail-closed pra-integrasi (MD-007)"
                    : "cipher vault tidak aman (mis. adapter uji deterministik) — " +
                        "kredensial nyata tidak pernah disimpan di vault tidak aman (MD-007)"
            };
        }
        if (!providerId || typeof providerId !== "string" ||
            !Object.prototype.hasOwnProperty.call(OPTIONAL_PROVIDER_CREDENTIALS, providerId)) {
            return { ok: false, code: "PROVIDER_UNKNOWN", reason: "provider tidak dikenal dalam skema kredensial Mata Dewa" };
        }
        if (typeof value !== "string" || !value.trim()) {
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

    /** Hapus kredensial (revoke di vault + hapus ref). Fail closed tanpa vault. */
    removeCredential(providerId) {
        const readiness = this._vaultReady();
        if (!readiness.ok) {
            return { ok: false, code: readiness.code, reason: "vault kanonik tidak terkomposisi — kredensial tidak dapat diubah (MD-007)" };
        }
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
     * Semantik jujur (MD-007):
     *  - tanpa kredensial terkonfigurasi → "credentials_absent" (tidak ada
     *    yang harus di-resolve — informasi paling akurat untuk UI);
     *  - kredensial ada TAPI vault kanonik tidak terkomposisi →
     *    "VAULT_NOT_COMPOSED" (fail-closed, tidak menembus).
     */
    resolveCredential = async (providerId) => {
        const refString = this.refs.get(providerId);
        if (!refString) return { ok: false, code: "credentials_absent" };
        const readiness = this._vaultReady();
        if (!readiness.ok) {
            return { ok: false, code: readiness.code };
        }
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
