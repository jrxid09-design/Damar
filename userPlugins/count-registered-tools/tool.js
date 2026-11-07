// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {

    constructor() {
        this.name = 'COUNT_REGISTERED_TOOLS';
        this.description = 'Mengambil daftar seluruh tool yang terdaftar di registry/TOOLBUS Aether dan menghitung jumlah totalnya beserta rincian per sumber (tool AI model-facing vs tool plugin inti).';
        this.parameters = {
            filter: { type: 'string', description: 'Filter opsional untuk nama atau deskripsi tool (case-insensitive).', required: false }
        };
    }
    async execute(args) {
        const path = require('node:path');
        const fs = require('node:fs');

        const filter = String(args?.filter ?? '').toLowerCase();

        // Kandidat lokasi ToolBus Aether relatif terhadap modul skill ini
        // (draft: userPlugins/.drafts/<id>/, live: userPlugins/<id>/, atau cwd root proyek).
        const busPaths = [
            path.join(__dirname, '..', '..', 'src', 'autonomy', 'ToolBus.js'),
            path.join(__dirname, '..', '..', '..', 'src', 'autonomy', 'ToolBus.js'),
            path.join(process.cwd(), 'src', 'autonomy', 'ToolBus.js')
        ];

        let list = null;
        for (const p of busPaths) {
            try {
                if (fs.existsSync(p)) {
                    const bus = require(p);
                    if (bus && typeof bus.discover === 'function') {
                        list = bus.discover(filter) || [];
                        break;
                    }
                }
            } catch (e) { /* coba kandidat berikutnya */ }
        }

        // Fallback: ToolRegistry inti saja bila ToolBus tak dapat dimuat.
        if (list === null) {
            const regPaths = [
                path.join(__dirname, '..', '..', 'src', 'core', 'tools'),
                path.join(__dirname, '..', '..', '..', 'src', 'core', 'tools'),
                path.join(process.cwd(), 'src', 'core', 'tools')
            ];
            let reg = null;
            for (const p of regPaths) {
                try {
                    if (fs.existsSync(p + '.js')) {
                        reg = require(p).ToolRegistry;
                        break;
                    }
                } catch (e) { /* coba kandidat berikutnya */ }
            }
            if (!reg) {
                return { ok: false, error: 'ToolBus/ToolRegistry Aether tidak ditemukan dari lokasi skill.' };
            }
            list = (reg.describe() || []).map(d => ({
                name: d.id,
                description: d.description ?? '',
                source: 'plugin'
            }));
            if (filter) {
                list = list.filter(t =>
                    t.name.toLowerCase().includes(filter) ||
                    (t.description ?? '').toLowerCase().includes(filter)
                );
            }
        }

        // Dedup berdasarkan nama supaya jumlah tool unik akurat.
        const seen = new Set();
        const tools = [];
        for (const t of list) {
            if (!t?.name || seen.has(t.name)) continue;
            seen.add(t.name);
            tools.push({ name: t.name, source: t.source ?? 'unknown' });
        }

        const perSource = {};
        for (const t of tools) {
            perSource[t.source] = (perSource[t.source] ?? 0) + 1;
        }

        return {
            ok: true,
            hasil: {
                total: tools.length,
                perSource,
                tools
            }
        };
    }

}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "COUNTREGISTEREDTOOLS";
        this.description = "Mengambil daftar seluruh tool yang terdaftar di registry/TOOLBUS Aether melalui ToolBus.discover() dengan fallback ke ToolRegistry.describe(), men-dedup nama tool, lalu menghitung jumlah total beserta rincian per sumber (AI atau plugin) sehingga sistem tahu berapa banyak kapabilitas executable yang tersedia saat ini.";
        this.parameters = {
    filter: {"type":"string","description":"Filter opsional untuk nama atau deskripsi tool (case-insensitive).","required":false}
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
