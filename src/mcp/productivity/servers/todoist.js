"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server todoist — tugas: daftar, buat, selesaikan, hapus.
 * Token Todoist tidak kedaluwarsa dan tanpa refresh (bundel tanpa
 * expiresAt ditangani tokenProvider). Basis API v1 terpadu Todoist;
 * jalur dapat diganti lewat env DAMAR_TODOIST_API_BASE bila Todoist
 * memindahkan API lagi.
 */

const SERVER_ID = "todoist";
const PROVIDER_ID = "todoist";
const API_BASE = process.env.DAMAR_TODOIST_API_BASE || "https://api.todoist.com/api/v1";

function createServer({ tokenStore, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const api = createApiClient({ tokenProvider: tokens, baseUrl: API_BASE, fetch: fetchImpl });

    const summarize = (t) => ({
        id: t.id, content: t.content,
        due: t.due?.date ?? t.due?.datetime ?? null,
        priority: t.priority ?? null,
        projectId: t.project_id ?? t.projectId ?? null
    });

    async function callTool(name, args = {}) {
        switch (name) {

            case "todoist_list_tasks": {
                const res = await api.request("tasks");
                const list = Array.isArray(res) ? res : (res.results ?? res.tasks ?? []);
                return { tasks: list.map(summarize) };
            }

            case "todoist_create_task": {
                const created = await api.request("tasks", {
                    method: "POST",
                    body: { content: args.content, ...(args.dueString ? { due_string: args.dueString } : {}) }
                });
                return { created: true, task: summarize(created) };
            }

            case "todoist_complete_task": {
                await api.request(`tasks/${encodeURIComponent(args.id)}/close`, { method: "POST" });
                return { completed: true, id: args.id };
            }

            case "todoist_delete_task": {
                await api.request(`tasks/${encodeURIComponent(args.id)}`, { method: "DELETE" });
                return { deleted: true, id: args.id };
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
