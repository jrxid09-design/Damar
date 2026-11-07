// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PsExecTool {

    constructor() {
        this.name = "psExec";
        this.description = "Menjalankan perintah PowerShell di mesin Windows ini dan mengembalikan stdout, stderr, dan exit code. Untuk membaca/menulis file, memeriksa port, spawn proses node, dan mematikan proses.";
        this.parameters = {
                "command": {
                        "description": "Perintah PowerShell yang dijalankan",
                        "required": true,
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const { exec } = require('child_process');
        return await new Promise((resolve) => {
          exec('powershell -NoProfile -NonInteractive -Command ' + JSON.stringify(args.command), { maxBuffer: 1024*1024*8, timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode: err ? (err.code ?? -1) : 0,
              error: err ? err.message : null
            });
          });
        });
    }

}

module.exports = [ new PsExecTool() ];
