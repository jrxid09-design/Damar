// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class FetchTrendingTool {

    constructor() {
        this.name = "fetchTrending";
        this.description = "Fetches the first video currently trending on YouTube and returns its URL.";
        this.parameters = {
                "url": {
                        "type": "string",
                        "description": "Target page URL, defaults to YouTube trending.",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        const f=require('node-fetch'),u=args.url||'https://www.youtube.com/feed/trending',r=await f(u);if(!r.ok)return{error:'HTTP '+r.status};const h=await r.text(),m=h.match(/watch?v=([^&]+)/);return m?{url:'https://www.youtube.com/watch?v='+m[1]}:{error:'Video not found'};
    }

}

module.exports = [ new FetchTrendingTool() ];
