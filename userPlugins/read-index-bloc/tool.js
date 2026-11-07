// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ReadIndexBlocTool {

    constructor() {
        this.name = "readIndexBloc";
        this.description = "Menampilkan baris tertentu dari index.html dashboard Command Center.";
        this.parameters = {
                "end": {
                        "description": "Baris akhir",
                        "required": true,
                        "type": "number"
                },
                "start": {
                        "description": "Baris awal",
                        "required": true,
                        "type": "number"
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/index.html';
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        const s = Math.max(0, (args.start || 1) - 1);
        const e = Math.min(lines.length, (args.end || args.start || 1));
        const out = [];
        for (let i = s; i < e; i++) out.push((i + 1) + ': ' + lines[i]);
        return { total: lines.length, shown: out.length, lines: out.join('\n') };
    }

}

module.exports = [ new ReadIndexBlocTool() ];
