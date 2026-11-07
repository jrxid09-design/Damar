// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class HttpFetchPageTool {

    constructor() {
        this.name = "httpFetchPage";
        this.description = "Mengambil konten halaman web / API via HTTP GET dengan header browser, mengembalikan status, headers, dan body. Dipakai untuk menelusuri profil atau postingan web.";
        this.parameters = {
                "url": {
                        "type": "string",
                        "description": "URL lengkap yang ingin diambil",
                        "required": true
                },
                "method": {
                        "type": "string",
                        "description": "HTTP method, default GET",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const u = new URL(args.url);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        try {
          const r = await fetch(u.toString(), {
            method: (args.method || 'GET').toUpperCase(),
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          });
          const body = await r.text();
          return {
            ok: r.ok,
            status: r.status,
            statusText: r.statusText,
            finalUrl: r.url,
            headers: Object.fromEntries(r.headers.entries()),
            bodyLength: body.length,
            body: body.slice(0, 5000)
          };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        } finally {
          clearTimeout(t);
        }
    }

}

module.exports = [ new HttpFetchPageTool() ];
