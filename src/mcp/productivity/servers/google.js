"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server google-workspace — Gmail + Google Drive + Google Calendar.
 *
 * Satu login Google (provider "google"), tiga kelompok tool. Layanan
 * yang dimatikan pengguna di Dashboard tidak diekspos: daftar tool
 * disaring dari keadaan terpusat (stateStore) saat server start, dan
 * scope consent juga hanya meminta layanan yang aktif.
 */

const SERVER_ID = "google-workspace";
const PROVIDER_ID = "google";

function decodeB64Url(data) {
    return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function headerOf(message, name) {
    const h = (message?.payload?.headers ?? []).find(
        x => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value ?? null;
}

function extractPlainText(payload) {
    if (!payload) return "";
    if (payload.mimeType === "text/plain" && payload.body?.data) {
        return decodeB64Url(payload.body.data);
    }
    for (const part of payload.parts ?? []) {
        const text = extractPlainText(part);
        if (text) return text;
    }
    if (payload.body?.data && (payload.mimeType === "text/html" || !payload.mimeType)) {
        return decodeB64Url(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return "";
}

function createServer({ tokenStore, state, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const doFetch = fetchImpl || globalThis.fetch;

    const gmail = createApiClient({ tokenProvider: tokens, baseUrl: "https://gmail.googleapis.com/gmail/v1", fetch: fetchImpl });
    const drive = createApiClient({ tokenProvider: tokens, baseUrl: "https://www.googleapis.com/drive/v3", fetch: fetchImpl });
    const calendar = createApiClient({ tokenProvider: tokens, baseUrl: "https://www.googleapis.com/calendar/v3", fetch: fetchImpl });

    const enabled = state ? state.enabledServices(SERVER_ID, descriptor.services) : [...descriptor.services];
    const tools = descriptor.tools.filter(t => !t.service || enabled.includes(t.service));

    async function callTool(name, args = {}) {
        switch (name) {

            case "gmail_list_messages": {
                const list = await gmail.request("users/me/messages", {
                    query: { q: args.query, maxResults: Math.min(args.maxResults ?? 10, 50) }
                });
                const out = [];
                for (const m of list.messages ?? []) {
                    const meta = await gmail.request(`users/me/messages/${m.id}`, { query: { format: "metadata" } });
                    out.push({
                        id: m.id,
                        from: headerOf(meta, "From"),
                        subject: headerOf(meta, "Subject"),
                        date: headerOf(meta, "Date"),
                        snippet: meta.snippet ?? null
                    });
                }
                return { messages: out, resultSizeEstimate: list.resultSizeEstimate ?? out.length };
            }

            case "gmail_get_message": {
                const msg = await gmail.request(`users/me/messages/${encodeURIComponent(args.id)}`, { query: { format: "full" } });
                return {
                    id: msg.id,
                    from: headerOf(msg, "From"),
                    to: headerOf(msg, "To"),
                    subject: headerOf(msg, "Subject"),
                    date: headerOf(msg, "Date"),
                    body: extractPlainText(msg.payload).slice(0, 20000)
                };
            }

            case "gmail_send_message": {
                const mime = [
                    `To: ${args.to}`,
                    `Subject: ${args.subject}`,
                    "Content-Type: text/plain; charset=utf-8",
                    "",
                    String(args.body ?? "")
                ].join("\r\n");
                const raw = Buffer.from(mime, "utf8").toString("base64")
                    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
                const sent = await gmail.request("users/me/messages/send", { method: "POST", body: { raw } });
                return { sent: true, id: sent.id, threadId: sent.threadId };
            }

            case "gmail_trash_message": {
                await gmail.request(`users/me/messages/${encodeURIComponent(args.id)}/trash`, { method: "POST", body: {} });
                return { trashed: true, id: args.id };
            }

            case "drive_list_files": {
                const res = await drive.request("files", {
                    query: {
                        q: args.query,
                        pageSize: Math.min(args.pageSize ?? 20, 100),
                        fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)"
                    }
                });
                return { files: res.files ?? [] };
            }

            case "drive_get_file": {
                return drive.request(`files/${encodeURIComponent(args.id)}`, {
                    query: { fields: "id,name,mimeType,modifiedTime,size,webViewLink,description" }
                });
            }

            case "drive_download_text": {
                const token = await tokens.getAccessToken();
                const res = await doFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.id)}?alt=media`, {
                    headers: { authorization: `Bearer ${token}` }
                });
                if (!res.ok) throw new ToolError(`API ${res.status}: unduh Drive gagal.`, "API_ERROR");
                const buf = Buffer.from(await res.arrayBuffer());
                const cap = args.maxBytes ?? 65536;
                return {
                    id: args.id,
                    truncated: buf.length > cap,
                    content: buf.subarray(0, cap).toString("utf8")
                };
            }

            case "drive_upload_file": {
                const token = await tokens.getAccessToken();
                const boundary = "damar_mcp_" + Date.now().toString(36);
                const metadata = {
                    name: args.name,
                    mimeType: args.mimeType || "text/plain",
                    ...(args.folderId ? { parents: [args.folderId] } : {})
                };
                const body = [
                    `--${boundary}`,
                    "Content-Type: application/json; charset=UTF-8",
                    "",
                    JSON.stringify(metadata),
                    `--${boundary}`,
                    `Content-Type: ${metadata.mimeType}`,
                    "",
                    String(args.contentText ?? ""),
                    `--${boundary}--`
                ].join("\r\n");
                const res = await doFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
                    body
                });
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new ToolError(`API ${res.status}: unggah Drive gagal (${data?.error?.message ?? "?"})`, "API_ERROR");
                return { uploaded: true, file: data };
            }

            case "drive_create_folder": {
                const created = await drive.request("files", {
                    method: "POST",
                    body: {
                        name: args.name,
                        mimeType: "application/vnd.google-apps.folder",
                        ...(args.parentId ? { parents: [args.parentId] } : {})
                    }
                });
                return { created: true, folder: created };
            }

            case "drive_delete_file": {
                await drive.request(`files/${encodeURIComponent(args.id)}`, { method: "DELETE" });
                return { deleted: true, id: args.id };
            }

            case "calendar_list_events": {
                const res = await calendar.request(`calendars/${encodeURIComponent(args.calendarId || "primary")}/events`, {
                    query: {
                        timeMin: new Date().toISOString(),
                        maxResults: Math.min(args.maxResults ?? 10, 50),
                        singleEvents: "true",
                        orderBy: "startTime"
                    }
                });
                return {
                    events: (res.items ?? []).map(e => ({
                        id: e.id, summary: e.summary ?? null,
                        start: e.start?.dateTime ?? e.start?.date ?? null,
                        end: e.end?.dateTime ?? e.end?.date ?? null,
                        location: e.location ?? null
                    }))
                };
            }

            case "calendar_create_event": {
                const created = await calendar.request(`calendars/${encodeURIComponent(args.calendarId || "primary")}/events`, {
                    method: "POST",
                    body: {
                        summary: args.summary,
                        description: args.description,
                        start: { dateTime: args.start },
                        end: { dateTime: args.end }
                    }
                });
                return { created: true, event: { id: created.id, htmlLink: created.htmlLink ?? null } };
            }

            case "calendar_delete_event": {
                await calendar.request(`calendars/${encodeURIComponent(args.calendarId || "primary")}/events/${encodeURIComponent(args.eventId)}`, { method: "DELETE" });
                return { deleted: true, id: args.eventId };
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
