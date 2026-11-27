"use strict";

const {
    SERVERS, SERVER_BY_ID, PROVIDER_BY_ID, providerForServer,
    scopesForServer, publicDescriptor
} = require("./registry");
const { createOAuthClient, createPkcePair, createState } = require("./oauth");

/**
 * connectService — otak alur connect/login suite produktivitas untuk
 * Control Dashboard.
 *
 * Alur OAuth (satu-satunya pola yang dapat dikirim untuk aplikasi
 * lokal open-source tanpa backend cloud):
 *   1. Pengguna membuat OAuth client SEKALI di konsol provider dan
 *      menempel client_id/secret di Dashboard → masuk Secret Vault.
 *   2. Klik "Connect" → URL consent provider (PKCE S256 + state
 *      sekali pakai, TTL 10 menit) → pengguna menyetujui di browser.
 *   3. Callback loopback Core menukar kode → token masuk vault →
 *      tool langsung hidup lewat McpClientManager.
 *   4. Disconnect: revoke di provider (bila didukung) + token lokal
 *      dihapus dari vault. Kredensial klien tetap tersimpan agar
 *      reconnect cukup satu klik; ada aksi terpisah untuk melupakan
 *      kredensial klien juga.
 *
 * Semua status yang keluar dari sini METADATA SAJA.
 */

const PENDING_TTL_MS = 10 * 60 * 1000;

function createConnectService({
    tokenStore,
    state,
    fetch: fetchImpl,
    now = Date.now,
    blenderBridgeFactory = null
} = {}) {
    if (!tokenStore) throw new Error("createConnectService butuh tokenStore.");
    if (!state) throw new Error("createConnectService butuh state store.");

    /** @type {Map<string, {state, verifier, serverId, redirectUri, at}>} providerId → pending */
    const pending = new Map();

    const oauthFor = (providerId) => createOAuthClient({
        provider: PROVIDER_BY_ID.get(providerId),
        fetch: fetchImpl,
        now
    });

    function serverOrThrow(serverId) {
        const server = SERVER_BY_ID.get(serverId);
        if (!server) {
            const e = new Error(`Server tidak dikenal: ${serverId}`);
            e.code = "SERVER_UNKNOWN";
            throw e;
        }
        return server;
    }

    /** Status satu server untuk Dashboard (metadata saja). */
    function statusOf(server) {
        const base = publicDescriptor(server);
        if (server.authType === "oauth2") {
            const st = tokenStore.status(server.provider);
            return {
                ...base,
                connection: {
                    state: st.connected ? "connected" : st.clientConfigured ? "disconnected" : "not_configured",
                    clientConfigured: st.clientConfigured,
                    account: st.account,
                    scopes: st.scopes,
                    expiresAt: st.expiresAt
                },
                servicesState: server.services
                    ? Object.fromEntries(server.services.map(k => [k, state.enabledServices(server.id, server.services).includes(k)]))
                    : null
            };
        }
        if (server.id === "filesystem") {
            return {
                ...base,
                connection: { state: "ready", grants: state.filesystemGrants() }
            };
        }
        if (server.id === "blender") {
            return {
                ...base,
                connection: { state: "ready", target: state.blenderTarget() }
            };
        }
        return { ...base, connection: { state: "ready" } };
    }

    function status() {
        return {
            vault: tokenStore.readiness(),
            servers: SERVERS.map(statusOf)
        };
    }

    /** Simpan kredensial klien OAuth dari Dashboard ke vault. */
    function saveClientCredentials(serverId, credentials) {
        const server = serverOrThrow(serverId);
        if (server.authType !== "oauth2") {
            const e = new Error(`Server '${serverId}' tidak memakai OAuth.`);
            e.code = "NOT_OAUTH";
            throw e;
        }
        tokenStore.setClientCredentials(server.provider, credentials);
        return { ok: true, serverId };
    }

    /** Lupakan kredensial klien + token sekaligus (factory reset per server). */
    function forgetClientCredentials(serverId) {
        const server = serverOrThrow(serverId);
        if (server.authType !== "oauth2") return { ok: true, serverId };
        tokenStore.clearAll(server.provider);
        return { ok: true, serverId };
    }

    /**
     * Mulai alur connect: kembalikan URL consent untuk dibuka browser.
     * redirectUri dibangun pemanggil (host loopback Core + path
     * callback) — pola yang sama dengan oauth-login OpenRouter.
     */
    function startConnect(serverId, { redirectUri } = {}) {
        const server = serverOrThrow(serverId);
        if (server.authType !== "oauth2") {
            const e = new Error(`Server '${serverId}' tidak memerlukan login.`);
            e.code = "NOT_OAUTH";
            throw e;
        }
        const provider = providerForServer(serverId);
        const client = tokenStore.getClientCredentials(provider.id);
        if (!client) {
            const e = new Error(
                `Kredensial klien ${provider.displayName} belum disimpan. ` +
                "Tempel client_id/secret dari konsol provider terlebih dahulu (satu kali)."
            );
            e.code = "CLIENT_NOT_CONFIGURED";
            throw e;
        }
        if (typeof redirectUri !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(redirectUri)) {
            const e = new Error("redirectUri harus URL loopback http://127.0.0.1…");
            e.code = "REDIRECT_INVALID";
            throw e;
        }
        const { verifier, challenge } = createPkcePair();
        const stateValue = createState();
        pending.set(provider.id, {
            state: stateValue, verifier, serverId, redirectUri, at: now()
        });
        const enabled = state.enabledServices(serverId, server.services);
        const scopes = scopesForServer(serverId, enabled ?? undefined);
        const authorizeUrl = oauthFor(provider.id).authorizeUrl({
            clientId: client.clientId,
            redirectUri,
            state: stateValue,
            codeChallenge: challenge,
            scopes
        });
        return { authorizeUrl, expiresInSec: PENDING_TTL_MS / 1000 };
    }

    /**
     * Tangani callback browser dari provider. `state` sekali pakai
     * adalah bukti CSRF-nya (pola localhost OAuth standar).
     */
    async function handleCallback(providerId, { code, state: stateValue, error } = {}) {
        const flow = pending.get(providerId);
        if (error) {
            pending.delete(providerId);
            return { ok: false, error: "OAUTH_DENIED" };
        }
        if (!flow || !stateValue || stateValue !== flow.state) {
            return { ok: false, error: "OAUTH_STATE_MISMATCH" };
        }
        if (now() - flow.at > PENDING_TTL_MS) {
            pending.delete(providerId);
            return { ok: false, error: "OAUTH_CODE_EXPIRED" };
        }
        if (typeof code !== "string" || !code) {
            return { ok: false, error: "OAUTH_CODE_MISSING" };
        }
        pending.delete(providerId); // sekali pakai, apa pun hasil tukarnya
        const client = tokenStore.getClientCredentials(providerId);
        if (!client) return { ok: false, error: "CLIENT_NOT_CONFIGURED" };
        const bundle = await oauthFor(providerId).exchangeCode({
            code,
            redirectUri: flow.redirectUri,
            codeVerifier: flow.verifier,
            clientId: client.clientId,
            clientSecret: client.clientSecret
        });
        tokenStore.setTokens(providerId, bundle);
        return { ok: true, serverId: flow.serverId };
    }

    /** Putuskan sambungan: revoke best-effort + hapus token lokal. */
    async function disconnect(serverId) {
        const server = serverOrThrow(serverId);
        if (server.authType !== "oauth2") return { ok: true, serverId };
        const providerId = server.provider;
        const bundle = (() => { try { return tokenStore.getTokens(providerId); } catch { return null; } })();
        const client = (() => { try { return tokenStore.getClientCredentials(providerId); } catch { return null; } })();
        let revoke = { revoked: false, supported: false };
        if (bundle?.accessToken && client) {
            revoke = await oauthFor(providerId).revoke({
                token: bundle.accessToken,
                clientId: client.clientId,
                clientSecret: client.clientSecret
            });
        }
        tokenStore.clearTokens(providerId);
        return { ok: true, serverId, revoke };
    }

    function setServiceEnabled(serverId, service, enabled) {
        const server = serverOrThrow(serverId);
        if (!server.services?.includes(service)) {
            const e = new Error(`Layanan '${service}' tidak ada di server '${serverId}'.`);
            e.code = "SERVICE_UNKNOWN";
            throw e;
        }
        state.setServiceEnabled(serverId, service, enabled);
        return { ok: true, serverId, service, enabled: Boolean(enabled) };
    }

    function setFilesystemGrants(grants) {
        return { ok: true, grants: state.setFilesystemGrants(grants) };
    }

    function setBlenderTarget(target) {
        state.setBlenderTarget(target);
        return { ok: true, target: state.blenderTarget() };
    }

    /** Pemeriksaan kesehatan hidup per server (untuk tombol "Tes"). */
    async function health(serverId) {
        const server = serverOrThrow(serverId);
        if (server.authType === "oauth2") {
            const st = tokenStore.status(server.provider);
            return { serverId, ok: st.connected, connected: st.connected };
        }
        if (serverId === "blender") {
            const { createBridge } = require("./servers/blender");
            const bridge = blenderBridgeFactory
                ? blenderBridgeFactory(state.blenderTarget())
                : createBridge(state.blenderTarget());
            try {
                const info = await bridge.send("get_scene_info");
                return { serverId, ok: true, connected: true, scene: info?.scene ?? null };
            } catch (e) {
                return { serverId, ok: false, connected: false, error: e.code || "BLENDER_UNREACHABLE" };
            }
        }
        if (serverId === "filesystem") {
            return { serverId, ok: true, grants: state.filesystemGrants().length };
        }
        return { serverId, ok: true };
    }

    return Object.freeze({
        status,
        statusOf,
        saveClientCredentials,
        forgetClientCredentials,
        startConnect,
        handleCallback,
        disconnect,
        setServiceEnabled,
        setFilesystemGrants,
        setBlenderTarget,
        health,
        _pendingCount: () => pending.size
    });
}

module.exports = { createConnectService, PENDING_TTL_MS };
