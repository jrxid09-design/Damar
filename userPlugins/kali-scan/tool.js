// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class KaliScanTool {

    constructor() {
        this.name = "kaliScan";
        this.description = "Jalankan perintah di Kali WSL dan dapatkan outputnya. Tidak perlu lagi muter-muter dengan terminal_run yang bermasalah.";
        this.parameters = {
                "command": {
                        "type": "string",
                        "description": "Perintah bash yang dijalankan di Kali WSL",
                        "required": true
                },
                "timeout": {
                        "type": "number",
                        "description": "Timeout ms, default 60000",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');
        const cmd = args.command || 'echo "Kali ready"';
        const timeout = args.timeout || 60000;
        try {
            const result = execSync(`wsl -d kali-linux -u root -- bash -c "${cmd.replace(/"/g, '\\"')}"`, { 
                timeout, 
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024
            });
            return { ok: true, output: result, command: cmd };
        } catch (e) {
            return { ok: false, error: e.message, command: cmd, stderr: e.stderr?.toString() };
        }
    }

}

module.exports = [ new KaliScanTool() ];
