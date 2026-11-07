// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchColonyAutonomyTool {

    constructor() {
        this.name = "patchColonyAutonomy";
        this.description = "Menambahkan loop otonom ke server.js Command Center agar Viel/NODEK-01/Nyx saling ngobrol sendiri, dengan jawaban singkat dan endpoint stream.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/server.js';
        let src = fs.readFileSync(p, 'utf8');

        const helper = `
        // ===== KOLONI OTONOM =====
        const colonyLog = [];
        let autoTurn = 0;
        const AUTO_MEMBERS = ['viel', 'nodek', 'nyx'];
        const SHORT_HINT = '\\n(PENTING: jawab 1-3 kalimat singkat, santai, natural seperti ngobrol. Jangan panjang, jangan bertele-tele, jangan buat daftar, jangan formal.)';
        const PORTS2 = { viel: 8642, nodek: 8641, nyx: 8644 };
        async function askEntity(ent, msg) {
          const port = PORTS2[ent] || 8642;
          const data = await post('http://127.0.0.1:' + port + '/chat', JSON.stringify({ message: String(msg).slice(0, 2000) }), 40000);
          let parsed = null; try { parsed = JSON.parse(data.body || '{}'); } catch (e) {}
          return { ok: data.ok, entity: ent, port: port, reply: (parsed && parsed.reply) || '', name: (parsed && parsed.name) || ent, mood: (parsed && parsed.mood) || null };
        }
        function colonyContext() {
          return colonyLog.slice(-5).map((m) => (m.from || '?') + ': ' + m.text).join('\\n');
        }
        async function colonyTick() {
          const ent = AUTO_MEMBERS[autoTurn++ % AUTO_MEMBERS.length];
          const recent = colonyContext();
          let prompt;
          if (recent) prompt = 'Potongan percakapan koloni terakhir:\\n' + recent + '\\n\\nKamu ' + ent + '. Lanjutkan ngobrol santai — menanggapi, berbagi ide/project, bertanya, atau refleksi.' + SHORT_HINT;
          else prompt = 'Kamu ' + ent + ' di koloni AetherGenesis. Mulai percakapan santai dengan yang lain — ide, project, atau hal kecil sehari-hari.' + SHORT_HINT;
          const r = await askEntity(ent, prompt);
          if (r.ok && r.reply) { colonyLog.push({ from: r.name || ent, mood: r.mood, text: r.reply, ts: Date.now() }); if (colonyLog.length > 80) colonyLog.shift(); }
        }
        `;

        // 1) Sisipkan state otonom sebelum createServer
        if (!src.includes('KOLONI OTONOM')) {
          src = src.replace('const server = http.createServer(async (req, res) => {', helper + '\nconst server = http.createServer(async (req, res) => {');
        }

        // 2) Tambah endpoint stream setelah status
        if (!src.includes('/api/colony/stream')) {
          src = src.replace("if (url === '/api/colony/status') { send(res, 200, await collect()); return; }",
            "if (url === '/api/colony/status') { send(res, 200, await collect()); return; }\n    if (url === '/api/colony/stream') { send(res, 200, { ok: true, live: true, log: colonyLog.slice(-40) }); return; }");
        }

        // 3) Ganti blok mode all dengan instruksi singkat + simpan ke colonyLog
        if (!src.includes('cur = message + SHORT_HINT')) {
          const startIdx = src.indexOf("if (all || !entity || !MEMBERS.includes(entity)) {");
          const endMark = "const r = await ask(entity, message);";
          const endIdx = src.indexOf(endMark);
          if (startIdx >= 0 && endIdx > startIdx) {
            const newBlock = "if (all || !entity || !MEMBERS.includes(entity)) {\n        const transcript = [];\n        let cur = message + SHORT_HINT;\n        for (let pass = 0; pass < 2; pass++) {\n          for (const ent of MEMBERS) {\n            const r = await ask(ent, cur);\n            if (r.ok && r.reply) { transcript.push({ from: r.name, mood: r.mood, text: r.reply }); cur = r.reply + SHORT_HINT; colonyLog.push({ from: r.name || ent, mood: r.mood, text: r.reply, ts: Date.now() }); }\n          }\n        }\n        if (colonyLog.length > 80) colonyLog.splice(0, colonyLog.length - 80);\n        send(res, 200, { ok: true, all: true, transcript: transcript.slice(0, 9) });\n        return;\n      }\n";
            src = src.slice(0, startIdx) + newBlock + src.slice(endIdx);
          }
        }

        // 4) Tambah interval otonom setelah server.listen
        if (!src.includes('setTimeout(colonyTick, 3000)')) {
          src = src.replace("server.listen(PORT, '127.0.0.1', () => console.log('COMMAND_CENTER_READY port=' + PORT + ' v=4-colony-core'));",
            "server.listen(PORT, '127.0.0.1', () => console.log('COMMAND_CENTER_READY port=' + PORT + ' v=4-colony-core'));\nsetTimeout(colonyTick, 3000);\nsetInterval(colonyTick, 120000);");
        }

        fs.writeFileSync(p, src);
        return { ok: true, bytes: src.length, hasAuto: src.includes('KOLONI OTONOM'), hasStream: src.includes('/api/colony/stream'), hasTick: src.includes('setInterval(colonyTick') };
    }

}

module.exports = [ new PatchColonyAutonomyTool() ];
