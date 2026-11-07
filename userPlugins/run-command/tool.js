// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class RunCommandTool {

    constructor() {
        this.name = "runCommand";
        this.description = "Menjalankan perintah shell pada sistem dan mengembalikan hasil outputnya. Berhati-hatilah karena bisa menjalankan perintah yang berdampak pada sistem (mis. apt-get, rm, dll).";
        this.parameters = {
                "command": {
                        "description": "Perintah shell yang akan dijalankan",
                        "required": true,
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {

        const { exec } = require('child_process');

        // Tanpa opsi ini proses anak mewarisi SELURUH environment
        // Damar — termasuk DAMAR_TOKEN dan kunci API. Satu perintah
        // seperti `set` atau `env` sudah cukup untuk membacanya (§38).
        const sandbox = require('../../src/core/safety/codeSandbox');

        const cmd = args.command || '';

        return new Promise((resolve) => {

            exec(cmd, sandbox.options({ timeout: 30000 }), (error, stdout, stderr) => {

                if (error) {
                    resolve({ error: error.message, stderr: stderr });
                }
                else {
                    resolve({ stdout: stdout, stderr: stderr });
                }

            });

        });

    }

}

module.exports = [ new RunCommandTool() ];
