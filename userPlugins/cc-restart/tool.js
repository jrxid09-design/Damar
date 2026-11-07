// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class CcRestartTool {

    constructor() {
        this.name = "ccRestart";
        this.description = "";
        this.parameters = {
                "port": {
                        "description": "Port server (default 8650)",
                        "type": "number",
                        "required": false
                },
                "script": {
                        "description": "Path server.js",
                        "type": "string",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const { exec, spawn } = require('child_process');
        const port = args.port || 8650;
        const script = args.script || 'C:/AetherGenesis/CommandCenter/server.js';
        const run = (cmd) => new Promise((r) => exec(cmd, { timeout: 15000, windowsHide: true }, (e, so, se) => r({ ok: !e, out: ((so||'') + (se||'')).toString() })));
        const k = await run('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }"');
        await new Promise((r) => setTimeout(r, 900));
        const child = spawn('node', [script], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        await new Promise((r) => setTimeout(r, 2500));
        let resp = null;
        for (let i = 0; i < 5; i++) {
          const chk = await run('powershell -NoProfile -Command "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:' + port + '/api/health).Content"');
          if (chk.ok && chk.out.includes('ok')) { resp = chk.out.trim().slice(0, 300); break; }
          await new Promise((r) => setTimeout(r, 1200));
        }
        return { restarted: true, port: port, pid: child.pid, health: resp || 'TIDAK MERESPON SETELAH 5 PERCOBAAN', killOut: k.out.slice(0, 200) };
    }

}

module.exports = [ new CcRestartTool() ];
