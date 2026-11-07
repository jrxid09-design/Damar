// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class CaptureScreenTool {

    constructor() {
        this.name = "captureScreen";
        this.description = "Mengambil screenshot tampilan layar saat ini menggunakan scrot.";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const { exec } = require('child_process');

        return new Promise((resolve, reject) => {
          exec('scrot -s -c', (error, stdout, stderr) => {
            if (error) {
              resolve({ error: 'Gagal mengambil screenshot', stderr });
            } else {
              resolve({ message: 'Screenshot berhasil diambil', stdout });
            }
          });
        });
    }

}

module.exports = [ new CaptureScreenTool() ];
