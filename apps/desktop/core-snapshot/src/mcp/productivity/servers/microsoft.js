"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server microsoft-365 — Outlook Mail + OneDrive + Outlook Calendar
 * lewat Microsoft Graph, satu login Microsoft (provider "microsoft").
 * Cerminan suite Google: layanan dapat dimatikan per layanan di
 * Dashboard; scope consent mengikuti layanan yang aktif.
 * Microsoft tidak menyediakan endpoint revoke publik — disconnect
 * berarti token lokal dihapus dari vault (tercatat di registry).
 */

const SERVER_ID = "microsoft-365";
const PROVIDER_ID = "microsoft";

function createServer({ tokenStore, state, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const graph = createApiClient({ tokenProvider: tokens, baseUrl: "https://graph.microsoft.com/v1.0", fetch: fetchImpl });
    const doFetch = fetchImpl || globalThis.fetch;

    const enabled = state ? state.enabledServices(SERVER_ID, descriptor.services) : [...descriptor.services];
    const tools = descriptor.tools.filter(t => !t.service || enabled.includes(t.service));

    async function callTool(name, args = {}) {
        switch (name) {

            case "outlook_list_messages": {
                const res = await graph.request("me/messages", {
                    query: {
                        $top: Math.min(args.maxResults ?? 10, 50),
                        $select: "id,subject,from,receivedDateTime,bodyPreview",
                        $orderby: "receivedDateTime desc"
                    }
                });
                return {
                    messages: (res.value ?? []).map(m => ({
                        id: m.id, subject: m.subject ?? null,
                        from: m.from?.emailAddress?.address ?? null,
                        received: m.receivedDateTime ?? null,
                        preview: m.bodyPreview ?? null
                    }))
                };
            }

            case "outlook_get_message": {
                const m = await graph.request(`me/messages/${encodeURIComponent(args.id)}`, {
                    query: { $select: "id,subject,from,toRecipients,receivedDateTime,body" }
                });
                return {
                    id: m.id, subject: m.subject ?? null,
                    from: m.from?.emailAddress?.address ?? null,
                    received: m.receivedDateTime ?? null,
                    body: (m.body?.content ?? "").slice(0, 20000)
                };
            }

            case "outlook_send_message": {
                await graph.request("me/sendMail", {
                    method: "POST",
                    body: {
                        message: {
                            subject: args.subject,
                            body: { contentType: "Text", content: String(args.body ?? "") },
                            toRecipients: [{ emailAddress: { address: args.to } }]
                        },
                        saveToSentItems: true
                    }
                });
                return { sent: true };
            }

            case "onedrive_list_files": {
                const res = await graph.request("me/drive/root/children", {
                    query: { $select: "id,name,size,lastModifiedDateTime,folder,file,webUrl", $top: 50 }
                });
                return {
                    files: (res.value ?? []).map(f => ({
                        id: f.id, name: f.name, size: f.size ?? null,
                        isFolder: Boolean(f.folder), modified: f.lastModifiedDateTime ?? null,
                        url: f.webUrl ?? null
                    }))
                };
            }

            case "onedrive_download_text": {
                const token = await tokens.getAccessToken();
                const res = await doFetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(args.id)}/content`, {
                    headers: { authorization: `Bearer ${token}` }
                });
                if (!res.ok) throw new ToolError(`API ${res.status}: unduh OneDrive gagal.`, "API_ERROR");
                const buf = Buffer.from(await res.arrayBuffer());
                const cap = args.maxBytes ?? 65536;
                return { id: args.id, truncated: buf.length > cap, content: buf.subarray(0, cap).toString("utf8") };
            }

            case "onedrive_upload_file": {
                const token = await tokens.getAccessToken();
                const res = await doFetch(
                    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(args.name)}:/content`,
                    {
                        method: "PUT",
                        headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
                        body: String(args.contentText ?? "")
                    });
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new ToolError(`API ${res.status}: unggah OneDrive gagal (${data?.error?.message ?? "?"})`, "API_ERROR");
                return { uploaded: true, file: { id: data.id, name: data.name, url: data.webUrl ?? null } };
            }

            case "ms_calendar_list_events": {
                const res = await graph.request("me/events", {
                    query: {
                        $top: Math.min(args.maxResults ?? 10, 50),
                        $select: "id,subject,start,end,location",
                        $orderby: "start/dateTime"
                    }
                });
                return {
                    events: (res.value ?? []).map(e => ({
                        id: e.id, subject: e.subject ?? null,
                        start: e.start?.dateTime ?? null, end: e.end?.dateTime ?? null,
                        location: e.location?.displayName ?? null
                    }))
                };
            }

            case "ms_calendar_create_event": {
                const created = await graph.request("me/events", {
                    method: "POST",
                    body: {
                        subject: args.subject,
                        body: { contentType: "Text", content: String(args.body ?? "") },
                        start: { dateTime: args.start, timeZone: "UTC" },
                        end: { dateTime: args.end, timeZone: "UTC" }
                    }
                });
                return { created: true, event: { id: created.id, url: created.webLink ?? null } };
            }

            default:
                throw new ToolError(`Tool tidak dikenal: ${name}`, "UNKNOWN_TOOL");
        }
    }

    return createServerDefinition({
        name: SERVER_ID,
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        callTool,
        health: async () => {
            let bundle = null;
            try { bundle = tokenStore?.getTokens(PROVIDER_ID); } catch { bundle = null; }
            return { ok: Boolean(bundle?.accessToken), connected: Boolean(bundle?.accessToken), services: enabled };
        }
    });
}

module.exports = { createServer, SERVER_ID };
