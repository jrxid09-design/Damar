"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { refs } = require("../../runtime/vault");

/**
 * tokenStore — penyimpanan kredensial klien + token OAuth suite
 * produktivitas di Secret Vault KANONIK Damar.
 *
 * Mengikuti pola konsumen vault yang sudah teruji (MataDewa
 * credentials.js):
 *   - TIDAK ada secret store kedua. Nilai rahasia (client_secret,
 *     access/refresh token) hidup HANYA sebagai envelope di vault.
 *   - Yang persisten di berkas lokal (data/mcp-productivity/refs.json,
 *     di-ignore git) hanya string SecretRef "secretref:v1:..." —
 *     tidak pernah nilai.
 *   - FAIL CLOSED: tanpa vault yang dikomposisi EKSPLISIT oleh
 *     composition root, semua operasi menolak dengan kode jujur
 *     (VAULT_NOT_COMPOSED). Cipher yang menyatakan dirinya tidak aman
 *     juga ditolak (VAULT_CIPHER_NOT_SECURE), kecuali komposisi secara
 *     sadar mengakui sebaliknya (allowInsecureCipher — hanya untuk
 *     tes/dev lokal, tercatat di status).
 *   - Status yang keluar modul ini METADATA SAJA (terhubung/tidak,
 *     akun, scope, kedaluwarsa) — nilai token tidak pernah keluar
 *     kecuali lewat getTokens()/getClientCredentials() internal untuk
 *     pemanggilan API, dan tidak pernah di-log.
 */

const SCOPE = Object.freeze({ kind: "provider", key: "mcp-productivity" });

class ProductivityTokenStore {

    /**
     * @param {{ vault?: object|null, refsFile?: string|null, allowInsecureCipher?: boolean }} options
     *   vault: instance Secret Vault (createSecretVault) dari komposisi.
     *   refsFile: jalur refs.json; null = hanya memori (tes).
     */
    constructor({ vault = null, refsFile = null, allowInsecureCipher = false } = {}) {
        this.vaultExplicit = vault !== null && vault !== undefined;
        this.vault = vault;
        this.refsFile = refsFile;
        this.allowInsecureCipher = allowInsecureCipher === true;
        /** @type {Map<string, string>} "client:<provider>"/"tokens:<provider>" → secretref */
        this.refs = new Map();
        if (refsFile && fs.existsSync(refsFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(refsFile, "utf8"));
                for (const [key, ref] of Object.entries(parsed?.refs ?? {})) {
                    if (typeof ref === "string" && ref.startsWith("secretref:v1:")) {
                        this.refs.set(key, ref);
                    }
                }
            } catch { /* refs korup → mulai kosong; jangan crash */ }
        }
    }

    _ready() {
        if (!this.vaultExplicit) return { ok: false, code: "VAULT_NOT_COMPOSED" };
        try {
            const cipher = this.vault.stats?.().cipher;
            if (cipher && cipher.secure === false && !this.allowInsecureCipher) {
                return { ok: false, code: "VAULT_CIPHER_NOT_SECURE" };
            }
        } catch {
            return { ok: false, code: "VAULT_CIPHER_NOT_SECURE" };
        }
        return { ok: true };
    }

    /** Kesiapan vault (untuk status Dashboard — kode saja, tanpa nilai). */
    readiness() {
        const r = this._ready();
        return { ready: r.ok, code: r.ok ? null : r.code, insecureCipherAcknowledged: this.allowInsecureCipher };
    }

    _put(key, jsonString, label) {
        const readiness = this._ready();
        if (!readiness.ok) {
            const err = new Error(`Penyimpanan kredensial fail-closed: ${readiness.code}`);
            err.code = readiness.code;
            throw err;
        }
        const oldRef = this.refs.get(key);
        if (oldRef) {
            try { this.vault.revoke(oldRef); } catch { /* best-effort */ }
            this.refs.delete(key);
        }
        const created = this.vault.create({ scope: SCOPE, label, value: jsonString });
        this.refs.set(key, refs.secretRefToString(created.ref));
        this._persist();
    }

    _get(key) {
        const refString = this.refs.get(key);
        if (!refString) return null;
        const readiness = this._ready();
        if (!readiness.ok) {
            const err = new Error(`Resolusi kredensial fail-closed: ${readiness.code}`);
            err.code = readiness.code;
            throw err;
        }
        const resolved = this.vault.resolveIn(SCOPE, refString);
        if (!resolved?.ok) return null;
        try {
            return JSON.parse(resolved.value.reveal());
        } catch {
            return null;
        }
    }

    _delete(key) {
        const refString = this.refs.get(key);
        if (!refString) return false;
        try { this.vault.revoke(refString); } catch { /* best-effort */ }
        this.refs.delete(key);
        this._persist();
        return true;
    }

    // ---- Kredensial klien OAuth (dari Dashboard, sekali saja) ------

    setClientCredentials(providerId, { clientId, clientSecret } = {}) {
        if (typeof clientId !== "string" || !clientId.trim()
            || typeof clientSecret !== "string" || !clientSecret.trim()) {
            throw new Error("clientId + clientSecret wajib diisi.");
        }
        this._put(`client:${providerId}`, JSON.stringify({
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim()
        }), `mcp-productivity:${providerId}:client`);
        return { ok: true };
    }

    /** INTERNAL: hanya untuk pemanggilan token endpoint. Jangan di-log. */
    getClientCredentials(providerId) {
        return this._get(`client:${providerId}`);
    }

    hasClientCredentials(providerId) {
        return this.refs.has(`client:${providerId}`);
    }

    // ---- Token hasil consent ----------------------------------------

    setTokens(providerId, bundle) {
        this._put(`tokens:${providerId}`, JSON.stringify(bundle), `mcp-productivity:${providerId}:tokens`);
        return { ok: true };
    }

    /** INTERNAL: hanya untuk pemanggilan API provider. Jangan di-log. */
    getTokens(providerId) {
        return this._get(`tokens:${providerId}`);
    }

    hasTokens(providerId) {
        return this.refs.has(`tokens:${providerId}`);
    }

    clearTokens(providerId) {
        return this._delete(`tokens:${providerId}`);
    }

    clearAll(providerId) {
        const a = this._delete(`tokens:${providerId}`);
        const b = this._delete(`client:${providerId}`);
        return a || b;
    }

    /**
     * Status publik satu provider — METADATA SAJA.
     * Aman ditampilkan di Dashboard dan aman masuk log.
     */
    status(providerId) {
        const tokens = this.hasTokens(providerId) ? this._safeTokens(providerId) : null;
        return {
            provider: providerId,
            clientConfigured: this.hasClientCredentials(providerId),
            connected: Boolean(tokens?.accessToken),
            account: tokens?.account ?? null,
            scopes: tokens?.scopes ?? [],
            expiresAt: tokens?.expiresAt ?? null
        };
    }

    _safeTokens(providerId) {
        try {
            const t = this._get(`tokens:${providerId}`);
            if (!t) return null;
            // Jangan bocorkan nilai: hanya bentuk keberadaan + metadata.
            return {
                accessToken: typeof t.accessToken === "string" && t.accessToken ? "***" : null,
                scopes: Array.isArray(t.scopes) ? t.scopes : [],
                account: t.account ?? null,
                expiresAt: t.expiresAt ?? null
            };
        } catch {
            return null;
        }
    }

    _persist() {
        if (!this.refsFile) return;
        try {
            fs.mkdirSync(path.dirname(this.refsFile), { recursive: true });
            const payload = { schemaVersion: 1, refs: Object.fromEntries(this.refs) };
            fs.writeFileSync(this.refsFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
        } catch { /* persist best-effort; vault tetap sumber kebenaran */ }
    }
}

module.exports = { ProductivityTokenStore, TOKEN_SCOPE: SCOPE };
