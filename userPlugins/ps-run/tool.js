// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PsRunTool {

    constructor() {
        this.name = "psRun";
        this.description = "Menjalankan perintah PowerShell di mesin Windows ini, mengembalikan stdout/stderr + exit code. Untuk spawn proses node, cek status, dan membaca file.";
        this.parameters = {
                "command": {
                        "description": "Perintah PowerShell yang dijalankan",
                        "required": true,
                        "type": "string"
                },
                "timeout_ms": {
                        "description": "Timeout dalam milidetik (default 60000)",
                        "type": "number",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { spawn } = require('child_process');
        const c = args.command || '';
        const t = Number(args.timeout_ms || 60000);
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'powershell.exe' : '/bin/sh';
        const full = isWin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', c] : ['-c', c];
        const child = spawn(cmd, full, { windowsHide: true });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, t);
        const code = await new Promise(resolve => child.on('close', resolve));
        clearTimeout(timer);
        return { ok: code === 0, exitCode: code, stdout: out.slice(0, 12000), stderr: err.slice(0, 4000) };
    }

}

module.exports = [ new PsRunTool() ];
