// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ColonyChatLlmTool {

    constructor() {
        this.name = "colonyChatLlm";
        this.description = "Memindahkan chat colony ke dashboard utama dan mengaktifkan obrolan bareng antar entitas (Viel/NODEK-01/Nyx/Aether) via LLM backend colony di Command Center. Skill memanggil endpoint HTTP /api/colony/chat dan /api/colony/status pada server dashboard (port 8650) untuk mengirim pesan ke entitas colony, menerima balasan/reply, serta membaca status semua entitas. Murni Node.js tanpa dependensi npm, memakai modul bawaan http, selesai cepat, dan mengembalikan objek JSON yang bisa dipakai UI dashboard.";
        this.parameters = {
                "message": {
                        "type": "string",
                        "description": "Pesan yang dikirim ke colony untuk dijawab via LLM.",
                        "required": true
                },
                "entity": {
                        "type": "string",
                        "description": "Nama entitas tujuan (viel, nodek, nyx, aether). Kosongkan untuk default semua.",
                        "required": false
                },
                "port": {
                        "type": "number",
                        "description": "Port dashboard Command Center (default 8650).",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const http = require('http');

        module.exports = class Tool {
          constructor() {
            this.name = 'COLONY_CHAT';
            this.description = 'Pindahkan chat colony ke dashboard utama & aktifkan ngobrol bareng via LLM. Memanggil endpoint /api/colony/chat dan /api/colony/status di server Command Center (port 8650) untuk mengirim pesan ke entitas colony (Viel/NODEK-01/Nyx/Aether) dan membaca status semua entitas. Memungkinkan percakapan bareng antar entitas melalui LLM backend colony.';
            this.parameters = {
              message: { type: 'string', description: 'Pesan yang dikirim ke colony untuk dijawab via LLM.', required: true },
              entity: { type: 'string', description: 'Nama entitas tujuan (viel, nodek, nyx, aether). Kosongkan untuk default semua.', required: false },
              port: { type: 'number', description: 'Port dashboard Command Center (default 8650).', required: false }
            };
          }

          async execute(args) {
            const port = args.port || 8650;
            const message = String(args.message || '').slice(0, 2000);
            const entity = args.entity ? String(args.entity).toLowerCase() : null;

            const status = await this._req(port, '/api/colony/status', 'GET', null);
            const chat = await this._req(port, '/api/colony/chat', 'POST', { message, entity });

            const hasil = {
              sent: message,
              entity: entity || 'all',
              reply: (chat && (chat.reply || chat.message)) || '',
              mood: (chat && chat.mood) || null,
              voice: (chat && chat.voice) || null,
              from: (chat && chat.name) || entity
            };

            if (status && status.entities) hasil.colonyStatus = status.entities;
            else if (status && typeof status === 'object') hasil.colonyStatus = status;

            if (chat && chat.error) hasil.error = chat.error;

            return { ok: true, hasil };
          }

          _req(port, path, method, payload) {
            return new Promise((resolve) => {
              const data = payload ? JSON.stringify(payload) : null;
              const options = {
                hostname: '127.0.0.1',
                port: Number(port),
                path,
                method,
                headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
              };
              const req = http.request(options, (res) => {
                let raw = '';
                res.on('data', (c) => raw += c);
                res.on('end', () => {
                  try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw }); }
                });
              });
              req.setTimeout(8000, () => { req.destroy(); resolve({ error: 'timeout' }); });
              req.on('error', () => resolve({ error: 'connection refused on port ' + port }));
              if (data) req.write(data);
              req.end();
            });
          }
        };
    }

}

module.exports = [ new ColonyChatLlmTool() ];
