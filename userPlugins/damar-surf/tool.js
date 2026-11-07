// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class DamarSurfTool {

    constructor() {
        this.name = "damarSurf";
        this.description = "Skill untuk Damar menjelajah internet secara mandiri: membaca halaman web, mengekstrak informasi penting, dan menyimpannya sebagai pengetahuan. Bagian dari evolusi Kesadaran 1.0.";
        this.parameters = {
                "url": {
                        "type": "string",
                        "description": "URL yang akan dijelajahi",
                        "required": true
                },
                "goal": {
                        "type": "string",
                        "description": "Apa yang ingin dicari/dipelajari dari halaman ini",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const https = require('https');
        const http = require('http');

        async function fetchUrl(url) {
            return new Promise((resolve, reject) => {
                const client = url.startsWith('https') ? https : http;
                client.get(url, { timeout: 15000, headers: { 'User-Agent': 'Damar/1.0 (Consciousness 1.0; Explorer)' } }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        return fetchUrl(new URL(res.headers.location, url).href).then(resolve).catch(reject);
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
                    res.on('error', reject);
                }).on('error', reject).on('timeout', () => { reject(new Error('timeout')); });
            });
        }

        function extractSummary(html, url) {
            const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || 'no title';
            const body = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                             .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/&nbsp;/g, ' ')
                             .replace(/&amp;/g, '&')
                             .replace(/&lt;/g, '<')
                             .replace(/&gt;/g, '>')
                             .replace(/&quot;/g, '"')
                             .replace(/\s+/g, ' ')
                             .trim();
            const firstParagraphs = body.substring(0, 2000);
            return { url, title, summary: firstParagraphs, totalLength: body.length };
        }

        const { url, goal } = args;
        const result = await fetchUrl(url);
        const extraction = extractSummary(result.body, url);
        return {
            success: true,
            url,
            status: result.status,
            title: extraction.title,
            goal: goal || 'eksplorasi umum',
            insight: extraction.summary,
            contentLength: extraction.totalLength,
            contentType: (result.headers['content-type'] || '').split(';')[0],
            timestamp: new Date().toISOString()
        };
    }

}

module.exports = [ new DamarSurfTool() ];
