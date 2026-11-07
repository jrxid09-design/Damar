class DamarSpeakTool {
    getName() { return 'damarSpeak'; }
    getToolName() { return 'damarSpeak'; }
    getDescription() { return 'Damar berbicara dengan suara aslinya (Ardi) â€” terputar langsung di widget Console'; }
    getDefinition() {
        return {
            name: 'damarSpeak',
            description: 'Damar berbicara dengan suara aslinya via widget suara Console',
            parameters: {
                text: { type: 'string', required: true, description: 'Teks yang diucapkan dalam Bahasa Indonesia' },
                voice: { type: 'string', required: false, description: 'Voice edge-tts, default id-ID-ArdiNeural' },
                rate: { type: 'string', required: false, description: 'Kecepatan bicara, default -8%' },
                pitch: { type: 'string', required: false, description: 'Pitch suara, default -12Hz' }
            }
        };
    }
    async execute(context, args = {}) {
        const { execSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const dir = 'C:\\AetherGenesis\\AetherSelf\\voice';
        fs.mkdirSync(dir, { recursive: true });
        const text = (args.text || '').replace(/"/g, '');
        if (!text) return { ok: false, error: 'text kosong' };
        const voice = args.voice || 'id-ID-ArdiNeural';
        const rate = args.rate || '-8%';
        const pitch = args.pitch || '-12Hz';
        const file = path.join(dir, 'speak-' + Date.now() + '.mp3');
        execSync(`edge-tts --voice ${voice} --rate=${rate} --pitch=${pitch} --text "${text}" --write-media "${file}"`, { timeout: 60000 });
        const size = fs.statSync(file).size;
        const url = 'http://127.0.0.1:8643/voice/' + path.basename(file);
        fs.writeFileSync(path.join(dir, 'feed.json'), JSON.stringify({ url, text, ts: Date.now() }));
        try { fs.readdirSync(dir).filter(f=>f.startsWith('speak-')&&f.endsWith('.mp3')&&f!==path.basename(file)).forEach(f=>{try{fs.unlinkSync(path.join(dir,f))}catch(e){}}) } catch(e){}
        return { ok: true, url, file, size, text, voice };
    }
}
module.exports = [ new DamarSpeakTool() ];
