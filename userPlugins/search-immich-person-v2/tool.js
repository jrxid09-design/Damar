// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  async execute(args) {
    const http = require('http');
    const name = (args && args.name) ? args.name : 'ronny';
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: 2283,
        path: '/api/search/person?name=' + encodeURIComponent(name),
        method: 'GET',
        headers: {
          'x-api-key': process.env.IMMICH_API_KEY,
          'Accept': 'application/json'
        }
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ raw: data });
          }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.end();
    });
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "SEARCHIMMICHPERSONV2";
        this.description = "Mencari person di Immich API";
        this.parameters = {
    name: {"type":"string","description":"Nama person","required":false}
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
