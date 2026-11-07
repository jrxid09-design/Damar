// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FindColonyUi2Tool {

    constructor() {
        this.name = "findColonyUi2";
        this.description = "Menampilkan baris terkait chat colony di index.html dashboard untuk memahami dan menambahkan polling stream otonom.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/AetherGenesis/CommandCenter/index.html';
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (l.indexOf('colony') >= 0 || l.indexOf('COLONY') >= 0) hits.push((i + 1) + ': ' + l);
        }
        return { total: lines.length, hits: hits.join('\n') };
    }

}

module.exports = [ new FindColonyUi2Tool() ];
