/**
 * mcpHandler — jembatan MCP (Model Context Protocol) untuk Damar.
 *
 * Mengekspos registry tool Damar (140+ tool) ke klien MCP mana pun —
 * Claude Desktop, agen lain, atau penghuni koloni — lewat JSON-RPC 2.0
 * (initialize / tools/list / tools/call). Pola diadopsi dari FRIDAY
 * (friday-tony-stark: server MCP mengekspos tool; agen memakainya),
 * tapi di sini sumbernya registry Damar yang sudah ada.
 *
 * Keselamatan berlapis:
 *   - registry.execute() tetap melewati toolGuard (pagar risiko,
 *     konfirmasi, audit) — MCP tak menembusnya.
 *   - Tool DESTRUKTIF disembunyikan dari tools/list secara default
 *     (klien MCP non-interaktif tak bisa mengonfirmasi); dibuka hanya
 *     bila allowDestructive = true.
 *
 * Handler ini MURNI (tanpa HTTP) agar mudah diuji: beri objek registry
 * ({ describe(), has(id), execute(id,args,ctx) }).
 */

const PROTOCOL_VERSION = "2024-11-05";

function createMcpHandler({
    registry,
    isDestructive = () => false,
    allowDestructive = false,
    serverName = "damar",
    version = "2.0.0",

    /**
     * H9 — PERMISSION-BEFORE-DISCLOSURE.
     * Gerbang disklosur KANONIK (Authorization.disclosureFilter).
     * Bisa diinjeksi untuk test; default ke modul asli supaya tidak ada
     * daftar peran kedua yang bisa menyimpang.
     */
    disclosureFilter = (tools, exec) =>
        require("../ai/tools/Authorization").disclosureFilter(tools, exec)
} = {}) {

    if (!registry || typeof registry.describe !== "function") {
        throw new Error("mcpHandler butuh registry dengan describe()/has()/execute().");
    }

    /**
     * Tool yang boleh dilihat klien MCP — untuk identitas eksekusi
     * yang sama dengan tools/call (invariant A: disclosure dan
     * eksekusi memakai satu kebenaran otorisasi kanonik).
     * Tanpa identitas → fail-closed sebagai 'user' anonim.
     */
    function visibleTools(exec = null) {
        const candidates = registry.describe()
            .map(t => ({ ...t, name: t.id }));

        return disclosureFilter(candidates, exec ?? {})
            .filter(t => allowDestructive || !isDestructive(t.id))
            .map(t => ({
                name: t.id,
                description: (t.description || t.name || t.id) + (isDestructive(t.id) ? " [destruktif]" : ""),
                inputSchema: normalizeSchema(t.parameters)
            }));
    }

    /** Pastikan schema berbentuk JSON-Schema objek yang sah untuk MCP. */
    function normalizeSchema(params) {
        if (params && typeof params === "object" && params.type === "object") return params;
        // parameters gaya {nama:{type,description,required}} → JSON-Schema.
        if (params && typeof params === "object") {
            const properties = {}, required = [];
            for (const [k, v] of Object.entries(params)) {
                if (v && typeof v === "object" && v.type) {
                    properties[k] = { type: v.type, description: v.description || "" };
                    if (v.required) required.push(k);
                } else properties[k] = { type: "string" };
            }
            return { type: "object", properties, ...(required.length ? { required } : {}) };
        }
        return { type: "object", properties: {} };
    }

    const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
    const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    /**
     * Tangani satu pesan JSON-RPC MCP. Balikan objek respons, atau null
     * untuk notifikasi (tak butuh balasan).
     */
    async function handle(msg, ctx = null) {
        if (!msg || msg.jsonrpc !== "2.0") return rpcErr(msg?.id ?? null, -32600, "Invalid Request");
        const { id = null, method, params } = msg;

        switch (method) {
            case "initialize":
                return rpcOk(id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: serverName, version }
                });

            case "notifications/initialized":
            case "notifications/cancelled":
                return null;                                   // notifikasi: tanpa balasan

            case "ping":
                return rpcOk(id, {});

            case "tools/list":
                // H9: disklosur memakai identitas eksekusi yang sama
                // dengan tools/call (ctx.exec dari tokenGuard).
                return rpcOk(id, { tools: visibleTools(ctx?.exec) });

            case "tools/call": {
                const name = params?.name;
                const args = params?.arguments ?? {};
                if (!name || !registry.has(name)) return rpcErr(id, -32602, `Tool tidak dikenal: ${name}`);
                if (!allowDestructive && isDestructive(name)) {
                    return rpcOk(id, { content: [{ type: "text", text: `Tool '${name}' destruktif dan tak diizinkan lewat MCP (set DAMAR_MCP_ALLOW_DESTRUCTIVE=1).` }], isError: true });
                }
                try {
                    const result = await registry.execute(name, args, { source: "mcp", exec: ctx?.exec });
                    return rpcOk(id, { content: [{ type: "text", text: stringify(result) }] });
                } catch (e) {
                    return rpcOk(id, { content: [{ type: "text", text: "ERROR: " + (e?.message || String(e)) }], isError: true });
                }
            }

            default:
                return rpcErr(id, -32601, "Method not found: " + method);
        }
    }

    return { handle, visibleTools, PROTOCOL_VERSION };
}

function stringify(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { createMcpHandler };
