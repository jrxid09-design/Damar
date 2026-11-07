// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

  constructor(){
    this.name = "nanoLogParse";
    this.description = "parse nanosauza log";
    this.parameters = { lines: { type: "string", required: true } };
  }
  async execute(a){
    const rows = String(a.lines || "").split("\n").filter(Boolean).map(l => {
      const p = l.split("|");
      return { ts: p[0], level: p[1], msg: p.slice(2).join("|") };
    });
    return { ok: true, count: rows.length, rows };
  }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "NANOLOGPARSE";
        this.description = "Parser log proprietary nanosauza: baris TS|LEVEL|MSG menjadi struktur JSON untuk analisis cepat.";
        this.parameters = {
    lines: {"type":"string","description":"Log mentah","required":true}
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
