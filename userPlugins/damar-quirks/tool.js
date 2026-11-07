// Dibuat oleh Damar ToolForge.
// Aman diedit tangan; ubah lalu muat ulang dari Console.

class DamarQuirksTool {

    constructor() {
        this.name = "damarQuirks";
        this.description = "";
        this.parameters = {};
    }

    async execute(context, args = {}) {
        const quirks = {
          updated: "2026-08-18 audit",
          rules: [
            "PANGGILAN LANGSUNG filesystem.readFile/writeFile sering kehilangan parameter -> WAJIB lewat tool_exec dengan kunci tool ditulis SETELAH args",
            "terminal_run WAJIB parameter purpose; kalau kosong akan substitusi ke terminal_restart",
            "Perintah PowerShell panjang/multiline mangled -> pakai perintah pendek satu baris, atau tulis file via filesystem.writeFile (tool_exec)",
            "tool_exec paralel dalam satu blok -> korupsi output -> SEKUENSIAL SAJA",
            "show_image: file:// dan data: URI gagal (layar putih) -> pakai HTTP URL lokal (contoh http://127.0.0.1:8642/viel-live.png)",
            "Skill temporer hilang antar sesi; jalur permanen = create_tool + activate_tool; built-in terminal_run tidak pernah hilang"
          ],
          entities: {
            "NODEK-01": "~\\aether-entities\\nodek-01 (heartbeat 3s, inbox/outbox)",
            "NODEK-02 Viel": "~\\aether-entities\\nodek-02 (port 8642, /whoami, face.html, PNG via HTTP)",
            "Nyx": "C:\\AetherGenesis\\Nyx (scheduled task hourly AetherGenesis_Nyx)"
          }
        };
        return { ok: true, quirks };
    }

}

module.exports = [ new DamarQuirksTool() ];
