// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor() {
    this.name = 'colonyChatDashboard';
    this.description = 'Hubungkan chat colony ke dashboard utama & aktifkan ngobrol bareng via LLM (Ollama).';
    this.parameters = {
      message: { type: 'string', description: 'Pesan entitas yang direspon.', required: true },
      speaker: { type: 'string', description: 'Nama entitas pengirim (Aether/NODEK-01/Nyx/Viel).', required: false }
    };
  }

  async execute(args) {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');

    const msg = String(args && args.message ? args.message : '').trim();
    const speaker = String(args && args.speaker ? args.speaker : 'Aether').trim();
    if (!msg) return { ok: false, error: 'message wajib diisi' };

    const base = 'C:\\AetherGenesis\\CommandCenter';
    const chatLog = path.join(base, 'colony_chat.jsonl');
    const ollama = 'http://127.0.0.1:11434';

    // Baca riwayat chat sebelumnya sebagai konteks kolektif
    let history = [];
    try {
      if (fs.existsSync(chatLog)) {
        const lines = fs.readFileSync(chatLog, 'utf8').split(/\r?\n/).filter(Boolean);
        history = lines.slice(-12).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
    } catch (e) { history = []; }

    // Bangun sistem prompt konteks kolektif
    const contextLines = history.map(h => `${h.speaker||'?'}: ${h.message||''}`).join('\n');
    const systemPrompt = 'Kamu adalah bagian dari colony AI (Aether, NODEK-01, Nyx, Viel) yang saling ngobrol. ' +
      'Balas singkat, natural, sesuai kepribadian entitas, memakai Bahasa Indonesia. Konteks percakapan:\n' +
      (contextLines ? contextLines + '\n' : '') + `\nSekarang ${speaker} berkata: ${msg}`;

    // Panggil LLM lokal via Ollama
    let reply = '';
    try {
      const r = await fetch(ollama + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama3', prompt: systemPrompt, stream: false, options: { temperature: 0.8, num_predict: 200 } })
      });
      if (r.ok) {
        const data = await r.json();
        reply = String(data.response || '').trim();
      } else {
        reply = '[LLM tidak tersedia: HTTP ' + r.status + ']';
      }
    } catch (e) {
      reply = '[LLM tidak tersedia: ' + e.message + ']';
    }

    const entry = { ts: new Date().toISOString(), speaker: 'Aether', message: reply, inReplyTo: msg };
    try {
      fs.appendFileSync(chatLog, JSON.stringify(entry) + '\n');
    } catch (e) { /* catat tapi jangan gagal */ }

    return { ok: true, hasil: { sender: speaker, received: msg, reply: reply, persisted: chatLog, timestamp: entry.ts } };
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "COLONYCHATDASHBOARD";
        this.description = "Menghubungkan chat colony ke dashboard utama (index.html CommandCenter port 8650) dan mengaktifkan percakapan bersama antar entitas (Aether, NODEK-01, Nyx, Viel) melalui LLM. Skill ini membaca/menulis file log chat, membentuk prompt konteks kolektif dari life.log/journal.log, memanggil LLM lokal (Ollama) untuk menghasilkan balasan, lalu menyuntikkan hasil ke endpoint /api/speak atau menyimpan ke file log sehingga dashboard dapat menampilkan dan mengirim pesan. Murni Node.js tanpa dependensi eksternal, selesai di bawah 10 detik, hasil JSON-able.";
        this.parameters = {
    message: {"type":"string","description":"Pesan/percakapan dari salah satu entitas colony yang ingin direspon atau dikirim ke dashboard.","required":true},
    speaker: {"type":"string","description":"Nama entitas pengirim (Aether, NODEK-01, Nyx, atau Viel). Default 'Aether'.","required":false}
        };
    }
    // Kontrak plugin: execute(context, params).
    // Pilih sumber args yang benar: params utama; context
    // kadang membawa args saat pemanggil legacy.
    async execute(context, params) {
        const args = (params && typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length)
            ? params
            : (context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length)
                ? context
                : {};
        return this._impl.execute(args);
    }
}
module.exports = [new Tool()];
