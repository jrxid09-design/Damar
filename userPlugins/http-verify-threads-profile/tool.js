// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class HttpVerifyThreadsProfileTool {

    constructor() {
        this.name = "httpVerifyThreadsProfile";
        this.description = "Memeriksa bukti keberadaan profil Threads (username, full_name, bio, follower) di seluruh HTML halaman — untuk membedakan akun yang benar-benar ada vs shell app kosong.";
        this.parameters = {
                "url": {
                        "type": "string",
                        "description": "URL profil Threads",
                        "required": true
                }
        };
    }

    async execute(context, args = {}) {
        const u = new URL(args.url);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);
        async function get(uri) {
          const r = await fetch(uri, {
            method: 'GET', signal: ctrl.signal, redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
              'Accept': 'text/html,application/json,*/*;q=0.8'
            }
          });
          return { status: r.status, text: await r.text() };
        }
        try {
          const { status, text: html } = await get(u.toString());
          // Cari bukti profil di seluruh HTML
          const checks = {
            status,
            foundUsername: html.includes('anonymous_deadbeef'),
            foundFullName: (html.match(/"full_name":"([^"]+)"/g) || []).slice(0,5),
            foundBio: (html.match(/"biography":"([^"]{0,200})"/g) || []).slice(0,3),
            foundFollowers: (html.match(/"edge_followed_by":\{[^}]*"count":(\d+)/g) || []).slice(0,2),
            foundRepo: html.match(/github\.com\/[A-Za-z0-9_.\-/]+/g),
            foundThreadsText: (html.match(/"(?:text|caption|string_map_data)"/g) || []).length
          };
          // Cari blok yang menyebut profile/user di dalam seluruh body
          const idx = html.search(/deadbeef|is_verified|full_name|edge_followed_by|threads_bio/g);
          const snippet = idx >= 0 ? html.slice(Math.max(0, idx-200), idx+500) : null;
          return { checks, snippet };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        } finally { clearTimeout(t); }
    }

}

module.exports = [ new HttpVerifyThreadsProfileTool() ];
