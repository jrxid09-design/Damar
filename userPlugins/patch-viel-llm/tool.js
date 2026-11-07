// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PatchVielLlmTool {

    constructor() {
        this.name = "patchVielLlm";
        this.description = "Memperbaiki bug header di fungsi call() LLM pada entity.js Viel (nodek-02) yang menghasilkan header Content-Type invalid sehingga Viel jatuh ke jawaban template.";
        this.parameters = {
                "dummy": {
                        "description": "tidak dipakai",
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const fs = require('fs');
        const p = 'C:/Users/jrxid/aether-entities/nodek-02/entity.js';
        let c = fs.readFileSync(p, 'utf8');
        const start = c.indexOf('const qq=String.fromCharCode(34);');
        const end = c.indexOf('/**\n * Otak Viel: bangun percakapan');
        if (start === -1 || end === -1) return { ok: false, start: start, end: end, hint: 'marker not found' };
        const r1 = '    async function call(base,key,model){\n';
        const r2 = '        const H={ "Content-Type":"application/json", "Authorization":"Bearer "+key };\n';
        const r3 = '        const body=JSON.stringify({model:model,messages:messages,stream:false,temperature:0.7});\n';
        const r4 = '        const r=await fetch(base.replace(/\\/$/,"")+"/chat/completions",{method:"POST",headers:H,body:body,signal:AbortSignal.timeout(60000)});\n';
        const r5 = '        if(!r.ok)throw new Error("LLM HTTP "+r.status);\n';
        const r6 = '        const j=await r.json(); const txt=j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content; if(!txt)throw new Error("LLM balasan kosong"); return txt.trim();\n';
        const r7 = '    }\n';
        const r8 = '    try{return await call(CFG.llmUrl,CFG.llmKey,CFG.llmModel);}catch(e){log("LLM utama gagal: "+e.message+" - coba cadangan Aether");}\n';
        const r9 = '    try{return await call("http://127.0.0.1:3000/v1",process.env.AETHER_TOKEN||"not-needed","gemini-3.6-flash");}catch(e){log("LLM cadangan gagal: "+e.message);throw e;}\n';
        const r10 = '}\n';
        const replacement = r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + r9 + r10;
        const out = c.slice(0, start) + replacement + c.slice(end);
        fs.writeFileSync(p, out, 'utf8');
        return { ok: true, start: start, end: end };
    }

}

module.exports = [ new PatchVielLlmTool() ];
