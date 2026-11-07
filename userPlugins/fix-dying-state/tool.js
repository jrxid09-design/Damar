// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FixDyingStateTool {

    constructor() {
        this.name = "fixDyingState";
        this.description = "Memperbaiki entitas koloni (Viel, NODEK-01, Nyx) agar tidak langsung 'mati' karena state.json berisi dying:true dari operasi stop sebelumnya. Mengubah dying menjadi false di state.json dan memaksa st.dying=false saat proses start di entity.js.";
        this.parameters = {
                "dummy": {
                        "description": "tidak dipakai",
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const targets = [
          { state: 'C:/Users/jrxid/aether-entities/nodek-02/state.json', code: 'C:/Users/jrxid/aether-entities/nodek-02/entity.js' },
          { state: 'C:/Users/jrxid/aether-entities/nodek-01/state.json', code: 'C:/Users/jrxid/aether-entities/nodek-01/entity.js' },
          { state: 'C:/AetherGenesis/Nyx/state.json', code: 'C:/AetherGenesis/Nyx/entity.js' }
        ];
        const out = [];
        for (const t of targets) {
          try {
            // fix state.json dying=false
            if (fs.existsSync(t.state)) {
              let s = fs.readFileSync(t.state, 'utf8');
              s = s.replace(/"dying"\s*:\s*true/gi, '"dying": false');
              s = s.replace(/"dying"\s*:\s*1/gi, '"dying": false');
              fs.writeFileSync(t.state, s, 'utf8');
              out.push('state fixed: ' + t.state);
            }
            // fix entity.js: force st.dying=false right after loading state (after Object.assign line)
            if (fs.existsSync(t.code)) {
              let c = fs.readFileSync(t.code, 'utf8');
              if (c.indexOf('st.dying = false;') === -1) {
                // insert after the Object.assign line
                const m = c.indexOf('st = Object.assign(st,');
                if (m !== -1) {
                  const nl = c.indexOf('\n', m);
                  c = c.slice(0, nl + 1) + 'st.dying = false; // force alive\n' + c.slice(nl + 1);
                  fs.writeFileSync(t.code, c, 'utf8');
                  out.push('code patched: ' + t.code);
                }
              } else {
                out.push('code already has dying reset: ' + t.code);
              }
            }
          } catch (e) { out.push('ERR ' + t.code + ': ' + e.message); }
        }
        return { ok: true, out };
    }

}

module.exports = [ new FixDyingStateTool() ];
