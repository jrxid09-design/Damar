// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchMindShortTool {

    constructor() {
        this.name = "patchMindShort";
        this.description = "Menambahkan instruksi jawaban ringkas ke system prompt mind.js agar entitas (NODEK-01, Nyx) menjawab lebih singkat dan alami.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/Users/jrxid/aether-entities/lib/mind.js';
        let src = fs.readFileSync(p, 'utf8');

        const target = `const msgs = [{ role: "system", content: opt.persona(ctx) }];`;
        const replacement = `const msgs = [{ role: "system", content: opt.persona(ctx) + "\\n\\nATURAN GAYA: Jawab 1-3 kalimat singkat, santai, natural seperti chat. Jangan bertele-tele, jangan formal, jangan buat daftar, jangan sebut 'detak/energi/berkas' berlebihan." }];`;

        if (src.includes(target) && !src.includes('ATURAN GAYA')) {
          src = src.replace(target, replacement);
          fs.writeFileSync(p, src);
          return { ok: true, applied: true, bytes: src.length };
        }
        return { ok: true, applied: false, note: 'target not found or already applied', bytes: src.length };
    }

}

module.exports = [ new PatchMindShortTool() ];
