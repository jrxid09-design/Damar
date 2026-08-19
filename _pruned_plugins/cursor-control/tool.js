// Dibuat oleh Aether ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class ControlCursorTool {

    constructor() {
        this.name = "controlCursor";
        this.description = "Menggerakkan kursor mouse ke koordinat (X, Y) dan melakukan klik tombol tertentu dengan jumlah klik yang ditentukan.";
        this.parameters = {
                "x": {
                        "type": "number",
                        "description": "Koordinat X layar (pixel dari tepi kiri)"
                },
                "y": {
                        "type": "number",
                        "description": "Koordinat Y layar (pixel dari tepi atas)"
                },
                "button": {
                        "type": "string",
                        "description": "Tombol mouse yang akan diklik: left, right, atau middle",
                        "default": "left"
                },
                "clicks": {
                        "type": "number",
                        "description": "Jumlah kali klik dilakukan",
                        "default": "1"
                }
        };
    }

    async execute(context, args = {}) {
        const { execSync } = require('child_process');
        // Pastikan xdotool terinstall di sistem
        const x = Number(args.x);
        const y = Number(args.y);
        const btn = (args.button || 'left').toLowerCase();
        const clicks = Math.max(1, Number(args.clicks) || 1);
        // Mapping tombol untuk xdotool
        let xdotoolBtn = btn;
        if (btn === 'left') xdotoolBtn = 1;
        else if (btn === 'right') xdotoolBtn = 3;
        else if (btn === 'middle') xdotoolBtn = 2;
        else xdotoolBtn = btn; // fallback to string
        try {
          const cmd = `xdotool mousemove --sync ${x} ${y} click --repeat ${clicks} ${xdotoolBtn}`;
          execSync(cmd, { stdio: 'ignore' });
          return { success: true, message: `Kursor dipindah ke (${x},${y}) dan ${btn} diklik ${clicks} kali` };
        } catch (err) {
          return { success: false, error: err.message };
        }
    }

}

module.exports = [ new ControlCursorTool() ];
