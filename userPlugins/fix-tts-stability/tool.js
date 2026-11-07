// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FixTtsStabilityTool {

    constructor() {
        this.name = "fixTtsStability";
        this.description = "Diagnosa dan matikan semua TTS selain ArdiNeural (edge-tts di port 8880). Cek Docker Kokoro, proses Node TTS liar, dan OS TTS. Lalu kill semua yang bukan ArdiNeural.";
        this.parameters = {
                "action": {
                        "type": "string",
                        "description": "diagnose (cek aja) atau fix (cek + matikan)",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');

        const action = args.action || 'fix';

        const results = [];

        // 1. Cek Docker Kokoro
        try {
            const dockerPs = execSync('docker ps --filter name=kokoro --format "{{.ID}} {{.Status}} {{.Names}}" 2>&1', { timeout: 10000 }).toString().trim();
            results.push({ check: 'docker-kokoro', running: dockerPs.length > 0, detail: dockerPs || 'not running' });
            
            if (dockerPs.length > 0) {
                // Matikan Kokoro
                execSync('docker stop kokoro 2>&1', { timeout: 15000 });
                // Pastikan tidak restart
                execSync('docker update --restart=no kokoro 2>&1', { timeout: 5000 });
                results.push({ action: 'docker-stop', ok: true, detail: 'Kokoro stopped & restart disabled' });
            }
        } catch (e) {
            results.push({ check: 'docker-kokoro', error: e.message });
        }

        // 2. Cek port 8880 (ArdiNeural), 8644, 5050
        try {
            const netstat = execSync('netstat -ano | findstr ":8880 :8644 :5050" 2>&1', { timeout: 10000 }).toString().trim();
            results.push({ check: 'tts-ports', detail: netstat || 'no TTS ports listening' });
        } catch (e) {
            results.push({ check: 'tts-ports', detail: 'none', error: e.message });
        }

        // 3. Cek proses Node yang mungkin TTS (voice-server, edge-tts, kokoro-wrapper)
        try {
            const nodeProcs = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv 2>&1', { timeout: 10000 }).toString();
            results.push({ check: 'node-processes', detail: nodeProcs.substring(0, 2000) });
            
            // Kill voice-server.js (port 8644) jika ada
            const lines = nodeProcs.split('\n');
            for (const line of lines) {
                if (line.includes('voice-server') || line.includes('kokoro')) {
                    const pidMatch = line.match(/(\d+)/);
                    if (pidMatch) {
                        try {
                            execSync(`taskkill /PID ${pidMatch[1]} /F 2>&1`, { timeout: 5000 });
                            results.push({ action: 'kill-voice-server', pid: pidMatch[1], ok: true });
                        } catch (e) {
                            results.push({ action: 'kill-voice-server', pid: pidMatch[1], error: e.message });
                        }
                    }
                }
            }
        } catch (e) {
            results.push({ check: 'node-processes', error: e.message });
        }

        // 4. Pastikan ArdiNeural jalan di 8880
        try {
            const check8880 = execSync('netstat -ano | findstr ":8880.*LISTENING" 2>&1', { timeout: 5000 }).toString().trim();
            results.push({ check: 'ardineural-8880', running: check8880.length > 0, detail: check8880 || 'NOT RUNNING' });
        } catch (e) {
            results.push({ check: 'ardineural-8880', running: false, error: e.message });
        }

        return { action, results, timestamp: new Date().toISOString() };
    }

}

module.exports = [ new FixTtsStabilityTool() ];
