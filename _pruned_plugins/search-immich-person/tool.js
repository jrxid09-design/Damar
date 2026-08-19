// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  async execute(args) {
    const http = require('http');
    const baseUrl = 'http://127.0.0.1:2283';
    const apiKey = 'z187FBvMrb2ACGegqlesy6xNoX4E8PqVJPmUCfLE';
    const name = args.name || 'ronny';

    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/person?name=${encodeURIComponent(name)}`, {
        headers: {
          'x-api-key': apiKey,
          'Accept': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            resolve({ raw: data, error: e.message });
          }
        });
      });
      req.on('error', err => reject(err));
    });
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "SEARCHIMMICHPERSON";
        this.description = "Mencari data orang/person dari server Immich berdasarkan nama.";
        this.parameters = {
    name: {"type":"string","description":"Nama orang yang dicari","required":false}
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
