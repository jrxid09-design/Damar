"use strict";

const { notConnected, ToolError } = require("./serverRuntime");

/**
 * tokenProvider — jahitan antara tokenStore (vault) dan pemanggilan
 * API provider di modul server.
 *
 * Tugasnya: ambil access token yang sah untuk satu provider; bila
 * kedaluwarsa dan ada refresh token, segarkan lewat kerangka OAuth
 * lalu simpan kembali ke vault. Nilai token hanya hidup sesaat di
 * memori pemanggil; tidak pernah di-log atau masuk pesan error.
 */

const EXPIRY_SKEW_MS = 30_000;

/**
 * @param {{ tokenStore: object, providerId: string,
 *           oauthClient: object, serverId: string }} deps
 *   oauthClient: hasil createOAuthClient untuk provider ini.
 */
function createTokenProvider({ tokenStore, providerId, oauthClient, serverId }) {
    if (!tokenStore) throw new Error("createTokenProvider butuh tokenStore.");

    async function getAccessToken({ now = Date.now() } = {}) {
        let bundle = null;
        try {
            bundle = tokenStore.getTokens(providerId);
        } catch (e) {
            throw new ToolError(`Token tidak dapat diakses (${e.code || "VAULT_ERROR"}).`, "TOKEN_UNAVAILABLE");
        }
        if (!bundle?.accessToken) throw notConnected(serverId);

        const expired = bundle.expiresAt !== null && bundle.expiresAt !== undefined
            && now >= bundle.expiresAt - EXPIRY_SKEW_MS;
        if (!expired || !bundle.refreshToken) return bundle.accessToken;

        const client = tokenStore.getClientCredentials(providerId);
        if (!client) throw notConnected(serverId);
        const fresh = await oauthClient.refresh({
            refreshToken: bundle.refreshToken,
            clientId: client.clientId,
            clientSecret: client.clientSecret
        });
        // Pertahankan metadata akun dari bundel lama bila yang baru kosong.
        if (!fresh.account || Object.keys(fresh.account).length === 0) {
            fresh.account = bundle.account ?? {};
        }
        if (!fresh.scopes?.length) fresh.scopes = bundle.scopes ?? [];
        tokenStore.setTokens(providerId, fresh);
        return fresh.accessToken;
    }

    return Object.freeze({ getAccessToken });
}

/**
 * Klien HTTP JSON untuk API provider, ber-Bearer token dari
 * tokenProvider. Kesalahan HTTP → ToolError berisi status + pesan
 * provider yang dipangkas (tanpa token).
 */
function createApiClient({ tokenProvider, baseUrl, fetch: fetchImpl, defaultHeaders = {} }) {
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("createApiClient butuh fetch.");

    async function request(pathname, { method = "GET", body, headers = {}, query } = {}) {
        const token = await tokenProvider.getAccessToken();
        const url = new URL(pathname.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
            }
        }
        const res = await doFetch(url.toString(), {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
                ...defaultHeaders,
                ...headers
            },
            ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            const msg = data?.error?.message || data?.error_description || data?.error || data?.message || `HTTP ${res.status}`;
            const err = new ToolError(`API ${res.status}: ${String(msg).slice(0, 200)}`, "API_ERROR");
            err.status = res.status;
            throw err;
        }
        return data ?? text;
    }

    return Object.freeze({ request });
}

module.exports = { createTokenProvider, createApiClient };
