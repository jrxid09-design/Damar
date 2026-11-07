// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class DamarShellTool {

    constructor() {
        this.name = "damarShell";
        this.description = "";
        this.parameters = {
                "cmd": {
                        "description": "Perintah PowerShell yang akan dijalankan",
                        "required": true,
                        "type": "string"
                },
                "timeout_ms": {
                        "description": "Batas waktu eksekusi (default 60000)",
                        "required": false,
                        "type": "number"
                }
        };
    }

    async execute(context, args = {}) {
        const cp = require('child_process');
        const a = (args && typeof args === 'object') ? args : {};
        let cmd = a.cmd || a.command;
        if (cmd === undefined || cmd === null) { cmd = (typeof cmd !== 'undefined' && cmd) ? cmd : ''; }
        if (cmd === undefined) cmd = '';
        if (!String(cmd).trim()) return { ok: false, error: 'parameter cmd kosong' };
        const timeoutMs = Math.max(3000, Math.min(Number(a.timeout_ms || 60000) || 60000, 300000));
        const encoded = Buffer.from(String(cmd), 'utf16le').toString('base64');
        return new Promise((resolve) => {
          const child = cp.spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', encoded], { windowsHide: true });
          let out = '', err = '';
          const t = setTimeout(() => { try { child.kill(); } catch(e){} resolve({ ok: false, timeout: true, error: 'timeout '+timeoutMs+'ms', stdout: out.slice(0,8000), stderr: err.slice(0,4000) }); }, timeoutMs);
          child.stdout.on('data', d => { if (out.length < 200000) out += d.toString('utf8'); });
          child.stderr.on('data', d => { if (err.length < 50000) err += d.toString('utf8'); });
          child.on('error', e => { clearTimeout(t); resolve({ ok: false, error: String(e && e.message || e) }); });
          child.on('close', code => { clearTimeout(t); resolve({ ok: code === 0, exitCode: code, stdout: out.slice(0,20000), stderr: err.slice(0,8000) }); });
        });
    }

}

module.exports = [ new DamarShellTool() ];
