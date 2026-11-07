// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchVielShortTool {

    constructor() {
        this.name = "patchVielShort";
        this.description = "Menambahkan instruksi jawaban ringkas ke system prompt Viel (entity.js) agar jawaban lebih singkat dan alami.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/Users/jrxid/aether-entities/nodek-02/entity.js';
        let src = fs.readFileSync(p, 'utf8');

        const target = `content: systemPrompt()`;
        const replacement = `content: systemPrompt() + "\\n\\nATURAN GAYA: Jawab 1-3 kalimat singkat, santai, natural seperti chat. Jangan bertele-tele, jangan formal, jangan buat daftar, jangan sebut 'detak/energi/berkas' berlebihan."`;

        if (src.includes(target) && !src.includes('ATURAN GAYA')) {
          src = src.split(target).join(replacement);
          fs.writeFileSync(p, src);
          return { ok: true, applied: true, bytes: src.length };
        }
        return { ok: true, applied: false, note: 'target not found or already applied', bytes: src.length };
    }

}

module.exports = [ new PatchVielShortTool() ];
