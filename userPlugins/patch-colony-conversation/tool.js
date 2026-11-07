// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchColonyConversationTool {

    constructor() {
        this.name = "patchColonyConversation";
        this.description = "Patch endpoint /api/colony/chat di CommandCenter server.js agar mendukung percakapan bersama (all) yang mengirim pesan ke Viel, NODEK-01, dan Nyx secara berurutan dan saling merespon, serta memperbaiki mapping port nodek ke 8641.";
        this.parameters = {
                "dummy": {
                        "description": "tidak dipakai",
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/server.js';
        let c = fs.readFileSync(p, 'utf8');
        const startMarker = "if (url === '/api/colony/chat' && req.method === 'POST') {";
        const endMarker = "if (url === '/api/colony/status')";
        const si = c.indexOf(startMarker);
        const ei = c.indexOf(endMarker);
        if (si === -1 || ei === -1 || ei < si) return { ok: false, si, ei, hint: 'marker not found' };
        const newBlock = [
          "    if (url === '/api/colony/chat' && req.method === 'POST') {",
          "      const b = await body(req);",
          "      let entity = '', message = '', all = false;",
          "      try { const d = JSON.parse(b || '{}'); entity = String(d.entity || '').toLowerCase(); message = String(d.message || ''); all = !!d.all; } catch (e) {}",
          "      if (!message.trim()) { send(res, 400, { ok: false, error: 'message kosong' }); return; }",
          "      const PORTS = { viel: 8642, nodek: 8641, nyx: 8644 };",
          "      async function ask(ent, msg) {",
          "        const port = PORTS[ent] || 8642;",
          "        const data = await post('http://127.0.0.1:' + port + '/chat', JSON.stringify({ message: String(msg).slice(0, 2000) }));",
          "        let parsed = null; try { parsed = JSON.parse(data.body || '{}'); } catch (e) {}",
          "        return { ok: data.ok, entity: ent, port: port, reply: (parsed && parsed.reply) || '', name: (parsed && parsed.name) || ent, mood: (parsed && parsed.mood) || null };",
          "      }",
          "      const MEMBERS = ['viel', 'nodek', 'nyx'];",
          "      if (all || !entity || !MEMBERS.includes(entity)) {",
          "        const transcript = [];",
          "        let cur = message;",
          "        for (let pass = 0; pass < 2; pass++) {",
          "          for (const ent of MEMBERS) {",
          "            const r = await ask(ent, cur);",
          "            if (r.ok && r.reply) { transcript.push({ from: r.name, mood: r.mood, text: r.reply }); cur = r.reply; }",
          "          }",
          "        }",
          "        send(res, 200, { ok: true, all: true, transcript: transcript.slice(0, 9) });",
          "        return;",
          "      }",
          "      const r = await ask(entity, message);",
          "      send(res, r.ok ? 200 : 502, { ok: r.ok, entity: r.entity, port: r.port, reply: r.reply, name: r.name, mood: r.mood, voice: null });",
          "      return;",
          "    }",
          "    "
        ].join('\n');
        const out = c.slice(0, si) + newBlock + c.slice(ei);
        fs.writeFileSync(p, out, 'utf8');
        return { ok: true, si, ei };
    }

}

module.exports = [ new PatchColonyConversationTool() ];
