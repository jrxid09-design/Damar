// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class AddHanriverCameraTool {

    constructor() {
        this.name = "addHanriverCamera";
        this.description = "Integrate Hanriver ID camera to Home Assistant";
        this.parameters = {
                "id": {
                        "type": "string",
                        "description": "Hanriver ID kamera"
                },
                "url": {
                        "type": "string",
                        "description": "URL RTSP/HTTP/OOB cameras"
                }
        };
    }

    async execute(context, args = {}) {
        const r = await fetch(`https://home-assistant.local/api/v1/cameras`, { method: 'POST', headers: { 'Authorization': 'Bearer <user_token>', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: args.id, name: 'Hanriver_CCTV', url: args.url }) }); return { ok: r.ok, message: 'Kamera ditambahkan' };
    }

}

module.exports = [ new AddHanriverCameraTool() ];
