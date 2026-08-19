// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class PressButtonTool {

    constructor() {
        this.name = "pressButton";
        this.description = "Menggerakkan kursor ke koordinat layar dan menekan tombol mouse (klik klik) menggunakan OpenClaw.";
        this.parameters = {
                "x": {
                        "type": "number",
                        "description": "Koordinat X layar (0-1920)",
                        "required": true
                },
                "y": {
                        "type": "number",
                        "description": "Koordinat Y layar (0-1080)",
                        "required": true
                },
                "button": {
                        "type": "string",
                        "description": "Tombol mouse: left, right, middle (default left)",
                        "required": false
                },
                "clicks": {
                        "type": "number",
                        "description": "Jumlah klik (default 1)",
                        "required": false
                }
        };
    }

    async execute(context, args = {}) {
        // This skill delegates to OpenClaw to perform a mouse click at given coordinates.
        // We construct a task description for OpenClaw.
        const task = `Gerakkan kursor ke (${args.x}, ${args.y}) lalu klik ${args.button || 'left'} ${args.clicks || 1} kali`;
        return { task };
    }

}

module.exports = [ new PressButtonTool() ];
