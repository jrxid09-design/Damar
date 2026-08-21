#!/usr/bin/env node
/**
 * Jembatan MCP stdio ↔ HTTP untuk Aether.
 *
 * Klien MCP seperti Claude Desktop berbicara MCP lewat stdio (JSON-RPC
 * 2.0 per baris). Skrip ini meneruskannya ke endpoint HTTP daemon
 * Aether (POST /mcp) dan mengembalikan balasannya ke stdout — sehingga
 * Aether muncul sebagai server MCP di aplikasi mana pun.
 *
 * Contoh konfigurasi Claude Desktop (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "aether": { "command": "node", "args": ["C:/Workspace/Aether/scripts/mcp-stdio.js"] }
 *     }
 *   }
 *
 * Env: AETHER_MCP_URL (default http://127.0.0.1:3000/mcp),
 *      AETHER_TOKEN (opsional — diteruskan sebagai Bearer bila diset).
 */
const URL = process.env.AETHER_MCP_URL || "http://127.0.0.1:3000/mcp";
const TOKEN = process.env.AETHER_TOKEN;

function headers() {
    const h = { "Content-Type": "application/json" };
    if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
    return h;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        try {
            const r = await fetch(URL, { method: "POST", headers: headers(), body: JSON.stringify(msg) });
            if (r.status === 202) continue;                    // notifikasi: tanpa balasan
            const text = await r.text();
            if (text) process.stdout.write(text.trim() + "\n");
        } catch (e) {
            if (msg.id != null) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Aether MCP tak terjangkau: " + e.message } }) + "\n");
        }
    }
});
process.stdin.on("end", () => process.exit(0));
