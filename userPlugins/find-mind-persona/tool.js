// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FindMindPersonaTool {

    constructor() {
        this.name = "findMindPersona";
        this.description = "Menampilkan baris mind.js yang berkaitan dengan persona/system prompt untuk menemukan tempat menambahkan instruksi jawaban ringkas.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/Users/jrxid/aether-entities/lib/mind.js';
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (/persona|system|prompt|ringkas|singkat|jawab/i.test(l)) hits.push((i + 1) + ': ' + l);
        }
        return { total: lines.length, hits: hits.join('\n') };
    }

}

module.exports = [ new FindMindPersonaTool() ];
