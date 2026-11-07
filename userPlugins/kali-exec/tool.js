// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class KaliExecTool {

    constructor() {
        this.name = "kaliExec";
        this.description = "Jalankan perintah shell di dalam container Kali Linux (kali-aether) via Docker. Mengembalikan stdout dan stderr.";
        this.parameters = {
                "command": {
                        "type": "string",
                        "description": "Perintah shell yang dijalankan di Kali",
                        "required": true
                },
                "timeout_sec": {
                        "type": "number",
                        "description": "Timeout dalam detik (default 30)",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');
        const cmd = args.command || args.cmd || '';
        if (!cmd) return { ok: false, error: 'no command provided' };
        try {
          const stdout = execSync(`docker exec kali-aether ${cmd}`, {
            encoding: 'utf-8',
            timeout: (args.timeout_sec || 30) * 1000,
            maxBuffer: 10 * 1024 * 1024
          });
          return { ok: true, stdout: stdout.trim() };
        } catch (e) {
          return { ok: false, error: e.stderr || e.message, stdout: e.stdout || '' };
        }
    }

}

module.exports = [ new KaliExecTool() ];
