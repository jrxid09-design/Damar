// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class HttpScrapeProfileTool {

    constructor() {
        this.name = "httpScrapeProfile";
        this.description = "Mengambil halaman web dan mengekstrak data JSON profil, teks terlihat, link GitHub, dan nama pengguna dari halaman Threads/forum.";
        this.parameters = {
                "url": {
                        "type": "string",
                        "description": "URL profil yang ingin dibedah",
                        "required": true
                }
        };
    }

    async execute(context, args = {}) {
        const u = new URL(args.url);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        try {
          const r = await fetch(u.toString(), {
            method: 'GET',
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          });
          let html = await r.text();
          // Ambil bagian <script type="application/json" data-sjs> yang biasanya memuat data profil Threads
          const chunks = [];
          const re = /<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gs;
          let m;
          while ((m = re.exec(html)) !== null && chunks.length < 8) {
            chunks.push(m[1].slice(0, 4000));
          }
          // Ekstrak teks yang tampak (bio, nama)
          const textVisible = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
          // Cari jejak repo github
          const gh = html.match(/github\.com\/[A-Za-z0-9_.\-/]+/g);
          return {
            ok: r.ok,
            status: r.status,
            finalUrl: r.url,
            bodyLength: html.length,
            jsonChunks: chunks,
            visibleText: textVisible,
            githubLinks: gh ? [...new Set(gh)].slice(0, 20) : [],
            hasDeadbeef: html.includes('anonymous_deadbeef'),
            hasProfileName: (html.match(/full_name[^,]{0,80}/g) || []).slice(0,5)
          };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        } finally {
          clearTimeout(t);
        }
    }

}

module.exports = [ new HttpScrapeProfileTool() ];
