"use strict";

const crypto = require("node:crypto");

/**
 * oauth — kerangka OAuth 2.0 generik suite produktivitas.
 *
 * SATU implementasi untuk semua provider (Google, Microsoft, Notion,
 * Slack, GitHub, Spotify, Todoist): authorization-code flow + PKCE
 * S256, state sekali pakai (dikelola connectService), tukar kode →
 * token, refresh, revoke. Perbedaan provider hidup di registry
 * (OAUTH_PROVIDERS): URL, pemisah scope, gaya autentikasi token
 * endpoint (body vs Basic), dan parameter authorize tambahan.
 *
 * Kredensial klien (client_id/secret) dan token TIDAK pernah disentuh
 * modul ini sebagai nilai yang disimpan — ia hanya meneruskannya ke
 * token endpoint; penyimpanan adalah urusan tokenStore (Secret Vault).
 * Tidak ada nilai rahasia yang di-log atau masuk pesan error.
 */

const b64url = (buf) => Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Pasangan PKCE baru: verifier rahasia + challenge S256 publik. */
function createPkcePair(randomBytes = crypto.randomBytes) {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}

/** State anti-CSRF acak (sekali pakai; masa berlaku di connectService). */
function createState(randomBytes = crypto.randomBytes) {
    return b64url(randomBytes(16));
}

function formEncode(params) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) body.set(k, String(v));
    }
    return body;
}

/**
 * Normalisasi respons token provider → bundel kanonik:
 *   { accessToken, refreshToken|null, expiresAt|null (epoch ms),
 *     scopes: string[], account: {…metadata non-rahasia}, obtainedAt }
 * Bentuk ganjil per provider ditangani di sini, bukan di pemanggil.
 */
function normalizeTokenResponse(provider, data, now) {
    if (!data || typeof data !== "object") {
        throw new Error(`Respons token ${provider.id} tidak sah.`);
    }
    if (provider.id === "slack" && data.ok === false) {
        throw new Error(`Slack menolak: ${String(data.error || "unknown_error").slice(0, 80)}`);
    }
    const accessToken = data.access_token
        ?? data.authed_user?.access_token   // Slack user-token (bila dipakai)
        ?? null;
    if (typeof accessToken !== "string" || !accessToken) {
        const msg = data.error_description || data.error || "tanpa access_token";
        throw new Error(`Token ${provider.id} ditolak: ${String(msg).slice(0, 120)}`);
    }
    const account = {};
    if (provider.id === "notion") {
        if (data.workspace_name) account.workspace = String(data.workspace_name).slice(0, 80);
        if (data.workspace_id) account.workspaceId = String(data.workspace_id).slice(0, 80);
    }
    if (provider.id === "slack" && data.team?.name) {
        account.workspace = String(data.team.name).slice(0, 80);
    }
    if (provider.id === "github" && data.scope) {
        // scope balik dari GitHub = daftar yang benar-benar diberikan.
    }
    const scopes = typeof data.scope === "string" && data.scope
        ? data.scope.split(/[\s,]+/).filter(Boolean)
        : [];
    return {
        accessToken,
        refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
        expiresAt: Number.isFinite(data.expires_in) ? now + data.expires_in * 1000 : null,
        scopes,
        account,
        obtainedAt: now
    };
}

/**
 * Klien OAuth untuk satu provider.
 * @param {{ provider: object, fetch?: Function, now?: Function }} deps
 */
function createOAuthClient({ provider, fetch: fetchImpl, now = Date.now } = {}) {
    if (!provider?.authUrl || !provider?.tokenUrl) {
        throw new Error("createOAuthClient butuh provider dengan authUrl/tokenUrl.");
    }
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("createOAuthClient butuh fetch.");

    /**
     * URL consent untuk dibuka pengguna di browser.
     * clientId bukan rahasia; ia datang dari vault lewat pemanggil.
     */
    function authorizeUrl({ clientId, redirectUri, state, codeChallenge, scopes }) {
        const u = new URL(provider.authUrl);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", clientId);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("state", state);
        u.searchParams.set("code_challenge", codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
        if (Array.isArray(scopes) && scopes.length) {
            u.searchParams.set("scope", scopes.join(provider.scopeSeparator ?? " "));
        }
        for (const [k, v] of Object.entries(provider.extraAuthorizeParams ?? {})) {
            u.searchParams.set(k, v);
        }
        return u.toString();
    }

    function tokenHeaders(clientId, clientSecret, extra = {}) {
        const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...extra };
        if (provider.tokenAuth === "basic") {
            headers.authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        }
        return headers;
    }

    function withClientSecret(params, clientId, clientSecret) {
        if (provider.tokenAuth === "basic") return params;
        return { ...params, client_id: clientId, client_secret: clientSecret };
    }

    async function tokenRequest(params, clientId, clientSecret, extraHeaders) {
        const res = await doFetch(provider.tokenUrl, {
            method: "POST",
            headers: tokenHeaders(clientId, clientSecret, extraHeaders),
            body: formEncode(withClientSecret(params, clientId, clientSecret))
        });
        let data = null;
        try { data = await res.json(); } catch { /* respons kosong/non-JSON */ }
        if (!res.ok) {
            const msg = data?.error_description || data?.error || `HTTP ${res.status}`;
            throw new Error(`Token ${provider.id} gagal: ${String(msg).slice(0, 120)}`);
        }
        return normalizeTokenResponse(provider, data, now());
    }

    /** Tukar authorization code → bundel token. */
    async function exchangeCode({ code, redirectUri, codeVerifier, clientId, clientSecret }) {
        return tokenRequest(
            { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier },
            clientId, clientSecret,
            provider.id === "notion" ? { "notion-version": "2022-06-28" } : {}
        );
    }

    /** Perbarui access token dari refresh token. */
    async function refresh({ refreshToken, clientId, clientSecret }) {
        const bundle = await tokenRequest(
            { grant_type: "refresh_token", refresh_token: refreshToken },
            clientId, clientSecret
        );
        // Sebagian provider tidak mengirim refresh token baru — pertahankan yang lama.
        if (!bundle.refreshToken) bundle.refreshToken = refreshToken;
        return bundle;
    }

    /** Cabut token di provider (best-effort; tidak semua provider punya endpoint). */
    async function revoke({ token, clientId, clientSecret }) {
        if (!provider.revokeUrl) return { revoked: false, supported: false };
        try {
            const headers = tokenHeaders(clientId, clientSecret);
            const res = await doFetch(provider.revokeUrl, {
                method: "POST",
                headers,
                body: formEncode(withClientSecret({ token }, clientId, clientSecret))
            });
            return { revoked: res.ok, supported: true };
        } catch {
            return { revoked: false, supported: true };
        }
    }

    return Object.freeze({
        provider,
        authorizeUrl,
        exchangeCode,
        refresh,
        revoke
    });
}

module.exports = { createOAuthClient, createPkcePair, createState, normalizeTokenResponse };
