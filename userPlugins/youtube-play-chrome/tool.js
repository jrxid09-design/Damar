// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PlayYoutubeOnChromeTool {

    constructor() {
        this.name = "playYoutubeOnChrome";
        this.description = "Membuka Chrome dengan hasil pencarian YouTube untuk lagu yang ditentukan, sehingga pengguna dapat menekan play langsung.";
        this.parameters = {
                "query": {
                        "type": "string",
                        "description": "Judul lagu atau pencarian YouTube"
                },
                "browser": {
                        "type": "string",
                        "description": "Perintah untuk membuka browser (mis. google-chrome, chromium-browser). Default: google-chrome",
                        "default": "google-chrome"
                }
        };
    }

    async execute(context, args = {}) {
        const { execFile } = require('child_process');
        const query = (args.query || '').trim();
        if (!query) {
          return { error: 'Query pencarian YouTube tidak boleh kosong.' };
        }
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

        // Lintas-OS: buka di browser default. Versi lama memakai
        // 'google-chrome' (perintah Linux) yang di Windows menghasilkan
        // "'google-chrome' is not recognized". Di sini pakai peluncur
        // bawaan tiap OS sehingga selalu jalan.
        const plat = process.platform;
        const [cmd, cmdArgs] =
            plat === 'win32'  ? ['cmd',  ['/c', 'start', '', url]] :
            plat === 'darwin' ? ['open', [url]] :
                                ['xdg-open', [url]];

        return await new Promise((resolve) => {
            execFile(cmd, cmdArgs, { windowsHide: true }, (err) => {
                if (err) resolve({ error: `Gagal membuka browser: ${err.message}`, url });
                else resolve({ opened: true, url, note: 'Dibuka di browser default. Tekan play.' });
            });
        });
    }

}

module.exports = [ new PlayYoutubeOnChromeTool() ];
