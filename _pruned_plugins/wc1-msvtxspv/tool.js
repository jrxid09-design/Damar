// Skill buatan Aether Skill Factory — jangan sunting manual.
class SkillImpl {
 async execute(args){ return { echo: args.inp }; } 
}

class Tool {
    constructor() {
        this._impl = new SkillImpl();
        this.name = "WCSATU";
        this.description = "Uji bungkus class polos dengan execute args untuk skill otonomi.";
        this.parameters = {
    inp: {"type":"string","description":"inp","required":true}
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
