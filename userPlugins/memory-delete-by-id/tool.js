// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  async execute(args) {
    const http = require('http');
    const id = args.id || '';
    if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
      return { ok: false, error: 'Parameter id wajib diisi (alfanumerik, tanpa spasi). Contoh: 15f68829d26b' };
    }
    const ports = [];
    if (process.env.AETHER_PORT) ports.push(Number(process.env.AETHER_PORT));
    [3210, 8650, 8080, 3000, 5000, 7777].forEach(p => { if (!ports.includes(p)) ports.push(p); });
    const tryPort = (port) => new Promise((resolve) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/api/memory/' + id, method: 'DELETE', timeout: 2500 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ port, status: res.statusCode, body: body.slice(0, 400) }));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
    for (const p of ports) {
      const r = await tryPort(p);
      if (r && r.status >= 200 && r.status < 500 && r.status !== 404) return { ok: true, deleted: id, result: r };
      if (r && r.status === 200) return { ok: true, deleted: id, result: r };
    }
    return { ok: false, error: 'Tidak ada endpoint penghapus memori yang merespons di port manapun. Perlu dukungan backend Aether.' };
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "MEMORYDELETEBYID";
        this.description = "Menghapus satu memori jangka panjang Aether berdasarkan ID via HTTP DELETE ke backend memori lokal (mencoba beberapa port umum: env AETHER_PORT, 3210, 8650, 8080, 3000).";
        this.parameters = {
    id: {"type":"string","description":"ID memori yang akan dihapus, mis. 15f68829d26b","required":true}
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
