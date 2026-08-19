// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PlayYoutubeChromeTool {

    constructor() {
        this.name = "playYoutubeChrome";
        this.description = "Membuka Google Chrome (atau browser default) dengan hasil pencarian YouTube untuk query yang diberikan.";
        this.parameters = {
                "query": {
                        "type": "string",
                        "description": "Kata kunci pencarian di YouTube",
                        "required": true
                }
        };
    }

    async execute(context, args = {}) {
        const { spawn } = require('child_process');
        const platform = process.platform;
        let cmd, argsArr;
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
        if (platform === 'win32') {
          cmd = 'start';
          argsArr = ['', url];
        } else if (platform === 'darwin') {
          cmd = 'open';
          argsArr = ['-a', 'Google Chrome', url];
        } else {
          cmd = 'xdg-open';
          argsArr = [url];
        }
        const child = spawn(cmd, argsArr, { detached: true, stdio: 'ignore' });
        child.unref();
        return { opened: true, url };
    }

}

module.exports = [ new PlayYoutubeChromeTool() ];
