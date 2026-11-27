"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server spotify — status/kontrol pemutaran + playlist.
 * Menyambung konteks media Damar yang sudah ada (Notch now-playing):
 * tool baca memberi keadaan pemutaran; tool kontrol tier "write"
 * (mengubah keadaan dunia luar → gerbang persetujuan).
 * Spotify menjawab 204 untuk kontrol sukses tanpa body — ditangani.
 */

const SERVER_ID = "spotify";
const PROVIDER_ID = "spotify";

function createServer({ tokenStore, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const doFetch = fetchImpl || globalThis.fetch;

    async function rawRequest(pathname, { method = "GET", body } = {}) {
        const token = await tokens.getAccessToken();
        const res = await doFetch(`https://api.spotify.com/v1/${pathname}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/json",
                ...(body !== undefined ? { "content-type": "application/json" } : {})
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        if (res.status === 204) return { ok: true, status: 204 };
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
            const msg = data?.error?.message || `HTTP ${res.status}`;
            const err = new ToolError(`Spotify ${res.status}: ${String(msg).slice(0, 160)}`, "API_ERROR");
            err.status = res.status;
            throw err;
        }
        return data;
    }

    async function callTool(name, args = {}) {
        switch (name) {

            case "spotify_get_playback": {
                const p = await rawRequest("me/player");
                if (!p || p.status === 204 || !p.item) return { playing: false, track: null };
                return {
                    playing: Boolean(p.is_playing),
                    track: {
                        name: p.item.name,
                        artists: (p.item.artists ?? []).map(a => a.name),
                        album: p.item.album?.name ?? null
                    },
                    device: p.device?.name ?? null,
                    progressMs: p.progress_ms ?? null
                };
            }

            case "spotify_list_playlists": {
                const res = await rawRequest(`me/playlists?limit=${Math.min(args.pageSize ?? 20, 50)}`);
                return {
                    playlists: (res.items ?? []).map(pl => ({
                        id: pl.id, name: pl.name, tracks: pl.tracks?.total ?? 0,
                        url: pl.external_urls?.spotify ?? null
                    }))
                };
            }

            case "spotify_get_playlist": {
                const pl = await rawRequest(`playlists/${encodeURIComponent(args.id)}`);
                return {
                    id: pl.id, name: pl.name, description: pl.description ?? null,
                    tracks: (pl.tracks?.items ?? []).map(it => ({
                        name: it.track?.name ?? null,
                        artists: (it.track?.artists ?? []).map(a => a.name)
                    }))
                };
            }

            case "spotify_play":
                await rawRequest("me/player/play", { method: "PUT" });
                return { playing: true };

            case "spotify_pause":
                await rawRequest("me/player/pause", { method: "PUT" });
                return { playing: false };

            case "spotify_next":
                await rawRequest("me/player/next", { method: "POST" });
                return { skipped: "next" };

            case "spotify_previous":
                await rawRequest("me/player/previous", { method: "POST" });
                return { skipped: "previous" };

            case "spotify_create_playlist": {
                const me = await rawRequest("me");
                const created = await rawRequest(`users/${encodeURIComponent(me.id)}/playlists`, {
                    method: "POST",
                    body: { name: args.name, description: args.description ?? "", public: false }
                });
                return { created: true, playlist: { id: created.id, name: created.name, url: created.external_urls?.spotify ?? null } };
            }

            case "spotify_add_to_playlist": {
                const res = await rawRequest(`playlists/${encodeURIComponent(args.playlistId)}/tracks`, {
                    method: "POST",
                    body: { uris: args.trackUris }
                });
                return { added: (args.trackUris ?? []).length, snapshotId: res.snapshot_id ?? null };
            }

            default:
                throw new ToolError(`Tool tidak dikenal: ${name}`, "UNKNOWN_TOOL");
        }
    }

    return createServerDefinition({
        name: SERVER_ID,
        tools: descriptor.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool,
        health: async () => {
            let bundle = null;
            try { bundle = tokenStore?.getTokens(PROVIDER_ID); } catch { bundle = null; }
            return { ok: Boolean(bundle?.accessToken), connected: Boolean(bundle?.accessToken) };
        }
    });
}

module.exports = { createServer, SERVER_ID };
