"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server slack — daftar channel, riwayat, kirim pesan.
 * API Slack menjawab HTTP 200 dengan { ok:false, error } untuk
 * kegagalan logis — diperiksa eksplisit di sini.
 */

const SERVER_ID = "slack";
const PROVIDER_ID = "slack";

function createServer({ tokenStore, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const api = createApiClient({ tokenProvider: tokens, baseUrl: "https://slack.com/api", fetch: fetchImpl });

    function checked(data) {
        if (data && data.ok === false) {
            throw new ToolError(`Slack: ${String(data.error || "unknown_error").slice(0, 120)}`, "API_ERROR");
        }
        return data;
    }

    async function callTool(name, args = {}) {
        switch (name) {

            case "slack_list_channels": {
                const res = checked(await api.request("conversations.list", {
                    query: { types: "public_channel,private_channel", limit: 100 }
                }));
                return {
                    channels: (res.channels ?? []).map(c => ({
                        id: c.id, name: c.name, isMember: Boolean(c.is_member), isPrivate: Boolean(c.is_private)
                    }))
                };
            }

            case "slack_get_history": {
                const res = checked(await api.request("conversations.history", {
                    query: { channel: args.channel, limit: Math.min(args.limit ?? 20, 100) }
                }));
                return {
                    messages: (res.messages ?? []).map(m => ({
                        user: m.user ?? m.bot_id ?? null,
                        text: (m.text ?? "").slice(0, 2000),
                        ts: m.ts ?? null
                    }))
                };
            }

            case "slack_post_message": {
                const res = checked(await api.request("chat.postMessage", {
                    method: "POST",
                    body: { channel: args.channel, text: args.text }
                }));
                return { posted: true, ts: res.ts ?? null, channel: res.channel ?? args.channel };
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
