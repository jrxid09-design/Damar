"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server notion — cari/baca/tulis halaman & database Notion.
 * OAuth Notion: token workspace, header Notion-Version wajib.
 */

const SERVER_ID = "notion";
const PROVIDER_ID = "notion";

function createServer({ tokenStore, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const api = createApiClient({
        tokenProvider: tokens,
        baseUrl: "https://api.notion.com/v1",
        fetch: fetchImpl,
        defaultHeaders: { "notion-version": "2022-06-28" }
    });

    const summarizePage = (p) => ({
        id: p.id,
        object: p.object,
        url: p.url ?? null,
        title: p.properties?.title?.title?.[0]?.plain_text
            ?? p.properties?.Name?.title?.[0]?.plain_text
            ?? p.child_page?.title
            ?? null,
        lastEdited: p.last_edited_time ?? null
    });

    async function callTool(name, args = {}) {
        switch (name) {

            case "notion_search": {
                const res = await api.request("search", {
                    method: "POST",
                    body: { query: args.query ?? "", page_size: 20 }
                });
                return { results: (res.results ?? []).map(summarizePage) };
            }

            case "notion_get_page": {
                const page = await api.request(`pages/${encodeURIComponent(args.pageId)}`);
                return summarizePage(page);
            }

            case "notion_list_databases": {
                const res = await api.request("search", {
                    method: "POST",
                    body: { filter: { value: "database", property: "object" }, page_size: 50 }
                });
                return {
                    databases: (res.results ?? []).map(db => ({
                        id: db.id,
                        title: db.title?.[0]?.plain_text ?? null,
                        url: db.url ?? null
                    }))
                };
            }

            case "notion_query_database": {
                const res = await api.request(`databases/${encodeURIComponent(args.databaseId)}/query`, {
                    method: "POST",
                    body: { page_size: Math.min(args.pageSize ?? 20, 100) }
                });
                return { rows: (res.results ?? []).map(summarizePage), hasMore: Boolean(res.has_more) };
            }

            case "notion_create_page": {
                const created = await api.request("pages", {
                    method: "POST",
                    body: {
                        parent: { page_id: args.parentPageId },
                        properties: {
                            title: { title: [{ text: { content: args.title } }] }
                        },
                        ...(args.contentText ? {
                            children: [{
                                object: "block", type: "paragraph",
                                paragraph: { rich_text: [{ type: "text", text: { content: String(args.contentText).slice(0, 2000) } }] }
                            }]
                        } : {})
                    }
                });
                return { created: true, page: summarizePage(created) };
            }

            case "notion_append_text": {
                const res = await api.request(`blocks/${encodeURIComponent(args.blockId)}/children`, {
                    method: "PATCH",
                    body: {
                        children: [{
                            object: "block", type: "paragraph",
                            paragraph: { rich_text: [{ type: "text", text: { content: String(args.text).slice(0, 2000) } }] }
                        }]
                    }
                });
                return { appended: true, blocks: (res.results ?? []).length };
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
