// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ScanScreenTool {

    constructor() {
        this.name = "scanScreen";
        this.description = "Mengambil screenshot layar dan mengembalikan path file untuk analisis lebih lanjut (mis. untuk deteksi koordinat atau konten visual).";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        // Mengambil screenshot layar menggunakan tool internal capture-screen
        const result = await global.__tools__.capture_screen__captureScreen({});
        return { screenshotPath: result.path };
    }

}

module.exports = [ new ScanScreenTool() ];
