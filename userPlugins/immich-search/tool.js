// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ImmichSearchTool {

    constructor() {
        this.name = "immichSearch";
        this.description = "Mencari foto di galeri Immich lokal berdasarkan kueri pencarian.";
        this.parameters = {
                "apiUrl": {
                        "description": "URL API Immich (default: http://127.0.0.1:2283)",
                        "type": "string"
                },
                "query": {
                        "description": "Kueri atau kata kunci pencarian (misal: 'ronny')",
                        "required": true,
                        "type": "string"
                }
        };
    }

    async execute(context, args = {}) {
        const apiUrl = args.apiUrl || 'http://127.0.0.1:2283';
        const query = args.query;
        const res = await fetch(`${apiUrl}/api/search/metadata`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ searchTerm: query })
        });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        return { result: data };
    }

}

module.exports = [ new ImmichSearchTool() ];
