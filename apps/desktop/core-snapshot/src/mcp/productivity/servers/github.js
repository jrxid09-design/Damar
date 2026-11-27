"use strict";

const { SERVER_BY_ID, PROVIDER_BY_ID } = require("../registry");
const { createOAuthClient } = require("../oauth");
const { createTokenProvider, createApiClient } = require("../tokenProvider");
const { createServerDefinition, ToolError } = require("../serverRuntime");

/**
 * Server github — repo, issue, dan pull request GitHub.
 * OAuth GitHub (classic OAuth App): token umumnya tidak kedaluwarsa
 * dan tidak ada refresh token; kerangka OAuth menanganinya sebagai
 * bundel tanpa expiresAt.
 */

const SERVER_ID = "github";
const PROVIDER_ID = "github";

function createServer({ tokenStore, fetch: fetchImpl } = {}) {
    const descriptor = SERVER_BY_ID.get(SERVER_ID);
    const provider = PROVIDER_BY_ID.get(PROVIDER_ID);
    const oauthClient = createOAuthClient({ provider, fetch: fetchImpl });
    const tokens = createTokenProvider({ tokenStore, providerId: PROVIDER_ID, oauthClient, serverId: SERVER_ID });
    const api = createApiClient({
        tokenProvider: tokens,
        baseUrl: "https://api.github.com",
        fetch: fetchImpl,
        defaultHeaders: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
    });

    const repoPath = (args) => `repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
    const summarizeIssue = (i) => ({
        number: i.number, title: i.title, state: i.state,
        author: i.user?.login ?? null, url: i.html_url ?? null,
        comments: i.comments ?? 0, createdAt: i.created_at ?? null
    });

    async function callTool(name, args = {}) {
        switch (name) {

            case "github_list_repos": {
                const res = await api.request("user/repos", {
                    query: { per_page: Math.min(args.pageSize ?? 20, 100), sort: "updated" }
                });
                return {
                    repos: (res ?? []).map(r => ({
                        fullName: r.full_name, private: r.private,
                        description: r.description ?? null, url: r.html_url,
                        updatedAt: r.updated_at
                    }))
                };
            }

            case "github_get_repo": {
                const r = await api.request(repoPath(args));
                return {
                    fullName: r.full_name, private: r.private, description: r.description ?? null,
                    url: r.html_url, stars: r.stargazers_count, forks: r.forks_count,
                    defaultBranch: r.default_branch, language: r.language ?? null
                };
            }

            case "github_list_issues": {
                const res = await api.request(`${repoPath(args)}/issues`, {
                    query: { state: args.state || "open", per_page: 30 }
                });
                return { issues: (res ?? []).filter(i => !i.pull_request).map(summarizeIssue) };
            }

            case "github_get_issue": {
                const i = await api.request(`${repoPath(args)}/issues/${args.number}`);
                return { ...summarizeIssue(i), body: (i.body ?? "").slice(0, 10000) };
            }

            case "github_list_pull_requests": {
                const res = await api.request(`${repoPath(args)}/pulls`, {
                    query: { state: args.state || "open", per_page: 30 }
                });
                return { pullRequests: (res ?? []).map(summarizeIssue) };
            }

            case "github_create_issue": {
                const created = await api.request(`${repoPath(args)}/issues`, {
                    method: "POST",
                    body: { title: args.title, body: args.body ?? "" }
                });
                return { created: true, issue: summarizeIssue(created) };
            }

            case "github_create_comment": {
                const created = await api.request(`${repoPath(args)}/issues/${args.number}/comments`, {
                    method: "POST",
                    body: { body: args.body }
                });
                return { created: true, comment: { id: created.id, url: created.html_url ?? null } };
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
