// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ReadServerChatBlocTool {

    constructor() {
        this.name = "readServerChatBloc";
        this.description = "Menampilkan blok baris tertentu dari server.js Command Center untuk memeriksa struktur sebelum di-patch.";
        this.parameters = {
                "start": {
                        "type": "number",
                        "description": "Baris awal (1-based)",
                        "required": true
                },
                "end": {
                        "type": "number",
                        "description": "Baris akhir",
                        "required": true
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/server.js';
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        const s = Math.max(0, (args.start || 1) - 1);
        const e = Math.min(lines.length, (args.end || args.start || 1));
        const out = [];
        for (let i = s; i < e; i++) out.push((i + 1) + ': ' + lines[i]);
        return { total: lines.length, shown: out.length, lines: out.join('\n') };
    }

}

module.exports = [ new ReadServerChatBlocTool() ];
