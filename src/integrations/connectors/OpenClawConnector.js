const AgentConnector = require("./AgentConnector");

/**
 * Konektor OpenClaw — DIREVERSE dari source terpasang (v2026.7.x).
 *
 * OpenClaw Gateway = WebSocket + HTTP multiplex di satu port (default 18789).
 * Endpoint HTTP yang relevan (source-of-truth: docs/gateway/*.md):
 *   - GET  /health          → {ok,status} (selalu ada).
 *   - POST /tools/invoke     → panggil SATU tool langsung (selalu aktif).
 *                              body: { tool, args, sessionKey?, action? }
 *                              resp: { ok, result:{content:[{type:"text",text}]}, details }
 *                              exec/spawn/shell diblokir kecuali di-allow via
 *                              gateway.tools.allow.
 *   - POST /v1/chat/completions → jalankan AGENT (OpenAI-compatible). MATI
 *                              secara default; model = target agent
 *                              ("openclaw/default"). Aktifkan via
 *                              gateway.http.endpoints.chatCompletions.enabled.
 * Auth: Bearer <gateway.auth.token|password> (isi sebagai apiKey di
 * configs/integrations.json).
 */
class OpenClawConnector extends AgentConnector {

    constructor(options = {}) {
        super({
            label: "OpenClaw",
            baseUrl: "http://localhost:18789",
            ...options,
            id: options.id ?? "openclaw",
            healthCandidates: options.healthCandidates ?? ["/health", "/api/health", "/healthz", "/"],
            // Task natural-language → agent lewat /v1/chat/completions.
            chatCandidates: options.chatCandidates ?? ["/v1/chat/completions"]
        });

        // OpenClaw memakai "model" sebagai TARGET AGENT, bukan model provider.
        this.metadata.defaultModel = this.metadata.defaultModel ?? "openclaw/default";
    }

    /**
     * Panggil satu tool Gateway langsung (deterministik, tanpa LLM).
     * mis. invokeTool("exec", { command: "notepad" }).
     */
    async invokeTool(name, args = {}, { sessionKey = "main", action = null } = {}) {

        const path = this.paths.toolsInvoke ?? "/tools/invoke";

        const body = { tool: name, args };
        if (action) body.action = action;
        if (sessionKey) body.sessionKey = sessionKey;

        const res = await this.httpClient.post(this.url(path), {
            headers: this.requestHeaders(),
            body,
            timeout: this.metadata.chatTimeout ?? 120000
        });

        if (!res.success || res.data?.ok === false) {
            const msg = res.data?.error?.message ?? res.error ?? res.statusText ?? `HTTP ${res.status}`;
            const err = new Error(`OpenClaw /tools/invoke "${name}": ${msg}`);
            err.status = res.status;
            throw err;
        }

        const d = res.data;
        const text =
            d?.result?.content?.find?.(c => c?.type === "text")?.text ??
            (typeof d?.result === "string" ? d.result : null) ??
            JSON.stringify(d?.details ?? d?.result ?? d);

        return { ok: true, text, raw: d };
    }

    /**
     * Tugas natural-language → jalankan sebagai agent OpenClaw.
     * Memakai AgentConnector.chat() (POST /v1/chat/completions, {model,messages}).
     * Butuh endpoint chatCompletions diaktifkan di config OpenClaw.
     */
    // chat() diwarisi dari AgentConnector — defaultModel="openclaw/default".

}

module.exports = OpenClawConnector;
