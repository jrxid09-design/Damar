// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FindVielPersonaTool {

    constructor() {
        this.name = "findVielPersona";
        this.description = "Menampilkan baris persona/system prompt di entity.js Viel untuk menemukan tempat menambahkan instruksi jawaban ringkas.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/Users/jrxid/aether-entities/nodek-02/entity.js';
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (/persona|system|prompt|PERSONA|identity|Identitas|kamu adalah|Kamu adalah|style|gaya|ringkas|singkat/i.test(l)) hits.push((i + 1) + ': ' + l);
        }
        return { total: lines.length, hits: hits.join('\n') };
    }

}

module.exports = [ new FindVielPersonaTool() ];
