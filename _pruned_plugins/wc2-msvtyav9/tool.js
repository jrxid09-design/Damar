// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {
 async execute(args){ return { upper: String(args.kata).toUpperCase(), len: String(args.kata).length }; } 
}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "WCDUA";
        this.description = "Uji kontrak registry penuh: execute context params lewat ToolRegistry dan ToolBus.";
        this.parameters = {
    kata: {"type":"string","description":"kata","required":true}
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
