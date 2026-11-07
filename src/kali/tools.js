const { AITool } = require("../ai/tools");
const kali = require("./bridge");

/**
 * Tool Kali Linux — Damar menguasai arsenal Kali lewat satu jembatan.
 *
 * Bukan 600 pembungkus: nmap, sqlmap, hydra, metasploit, dan sisanya
 * adalah program baris-perintah. Yang Damar butuhkan adalah cara ANDAL
 * menjalankannya di dalam Kali dan tahu mana yang terpasang — sisanya
 * penguasaan sintaks tiap tool, yang ada di doktrin & pengetahuan model.
 *
 * Pagar otorisasi ada di disiplin keamanan: pemindaian/uji aktif ke
 * target yang BUKAN milik pemilik butuh izin & cakupan dari pemilik.
 */
function kaliTools() {

    return [

        new AITool({
            name: "kali_run",
            description:
                "JALANKAN perintah/tool Kali Linux (nmap, sqlmap, nikto, hydra, gobuster, " +
                "msfconsole, john, hashcat, radare2, tcpdump, dsb.) di dalam distro Kali. " +
                "Ini jalur eksekusi keamanan yang sebenarnya — pakai untuk pentest yang " +
                "DIIZINKAN pemilik, CTF, lab, dan audit aset pemilik. Rangkai tool bila " +
                "perlu (mis. nmap temukan port lalu nikto pada layanan web). Berikan " +
                "perintah bash lengkap. Balikan { ok, code, stdout, stderr }. Untuk tool " +
                "interaktif (msfconsole), pakai mode non-interaktif (-x / resource script).",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Perintah bash lengkap, mis. \"nmap -sV -Pn 192.168.1.10\"." },
                    cwd: { type: "string", description: "Direktori kerja di dalam Kali (opsional), mis. /root/loot." },
                    timeout: { type: "number", description: "Batas waktu ms (default 300000)." }
                },
                required: ["command"]
            },
            // Risiko destruktif ditegakkan lewat riskCatalog.DESTRUCTIVE
            // (gerbang konfirmasi), bukan field di sini — AITool tak
            // menyimpan metadata.
            execute: async ({ command, cwd, timeout }) => kali.run(command, { cwd, timeout })
        }),

        new AITool({
            name: "kali_tools",
            description:
                "DAFTAR tool arsenal Kali yang terpasang, dikelompokkan per tugas (pemetaan " +
                "jaringan, web, kata sandi, nirkabel, eksploitasi, rekayasa balik, forensik, " +
                "OSINT, sniffing/MITM, Active Directory). Pakai untuk tahu apa yang tersedia " +
                "sebelum menyusun rencana, dan tool mana yang perlu dipasang.",
            parameters: { type: "object", properties: {} },
            execute: async () => kali.tools()
        }),

        new AITool({
            name: "kali_which",
            description:
                "Cek satu tool Kali terpasang atau tidak (dan path-nya). Lebih cepat dari " +
                "kali_tools bila hanya butuh memastikan satu tool sebelum memakainya.",
            parameters: {
                type: "object",
                properties: { tool: { type: "string", description: "Nama tool, mis. 'sqlmap'." } },
                required: ["tool"]
            },
            execute: async ({ tool }) => {
                const path = await kali.which(tool);
                return path ? { ok: true, tool, path } : { ok: false, tool, note: "Tak terpasang. Pasang: `sudo apt install " + String(tool).replace(/[^\w.-]/g, "") + "`." };
            }
        }),

        new AITool({
            name: "kali_status",
            description:
                "Status kesiapan Kali: distro WSL terdeteksi, rilis, dan apakah bisa dijalankan " +
                "sekarang. Panggil bila kali_run gagal untuk memastikan Kali memang tersedia " +
                "sebelum menyimpulkan sebab lain.",
            parameters: { type: "object", properties: {} },
            execute: async () => kali.status()
        })

    ];

}

module.exports = { kaliTools };
