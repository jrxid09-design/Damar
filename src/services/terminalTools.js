const { AITool } = require("../ai/tools");

const terminals = require("../runtime/terminal/TerminalRuntime");

/**
 * Tool AI untuk Terminal Runtime.
 *
 * Prinsip (ditegakkan lewat deskripsi + terminal_run/restart):
 * Aether TIDAK spawn shell sementara — ia cari terminal berdasarkan
 * PURPOSE yang stabil, pakai ulang bila ada, buat baru hanya bila perlu.
 *
 * SuperAdmin-only (shell = akses penuh mesin) — disaring roleService.
 */

const tail = (s, n = 2000) => (s && s.length > n ? s.slice(-n) : (s || ""));

function terminalTools() {

    return [

        new AITool({
            name: "terminal_list",
            description:
                "Lihat terminal yang sedang berjalan (id, nama, purpose, tipe, status). " +
                "Cek ini DULU sebelum membuat terminal baru.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
                terminals: terminals.list().map(t => ({
                    id: t.id, name: t.name, purpose: t.purpose, type: t.terminalType, status: t.status
                }))
            })
        }),

        new AITool({
            name: "terminal_run",
            description:
                "Jalankan perintah di terminal PERSISTEN berdasarkan `purpose`. Cari-atau-buat " +
                "terminal dengan purpose itu (JANGAN spawn shell sementara), lalu jalankan " +
                "perintah. Beri `expect` (regex) untuk menunggu output tertentu muncul " +
                "(mis. 'listening on|ready') pada proses yang lama hidup.",
            parameters: {
                type: "object",
                properties: {
                    purpose: { type: "string", description: "Kunci stabil terminal, mis. 'hermes','docker','build','python'." },
                    command: { type: "string", description: "Perintah yang dijalankan." },
                    expect: { type: "string", description: "Regex output yang ditunggu (opsional)." },
                    shell: { type: "string", description: "powershell|cmd|wsl|gitbash|bash (opsional)." },
                    cwd: { type: "string", description: "Direktori kerja (opsional)." }
                },
                required: ["purpose", "command"]
            },
            execute: async ({ purpose, command, expect, shell, cwd }) => {
                const meta = terminals.ensureByPurpose({ purpose, name: purpose, shell, cwd });
                const r = await terminals.execute(meta.id, command, { expect, timeoutMs: expect ? 30000 : 12000 });
                return { terminal: meta.id, purpose, matched: r.matched, output: tail(r.output) };
            }
        }),

        new AITool({
            name: "terminal_restart",
            description:
                "Mulai ulang layanan di terminalnya: cari terminal by `purpose`, kirim Ctrl+C, " +
                "lalu jalankan `command` lagi dan tunggu siap (`expect`). Buat baru bila belum " +
                "ada. Contoh: purpose='hermes', command='hermes serve', expect='listening'.",
            parameters: {
                type: "object",
                properties: {
                    purpose: { type: "string" },
                    command: { type: "string" },
                    expect: { type: "string" },
                    shell: { type: "string" },
                    cwd: { type: "string" }
                },
                required: ["purpose", "command"]
            },
            execute: async ({ purpose, command, expect, shell, cwd }) => {
                const existing = terminals.findByPurpose(purpose);
                let id;
                if (existing) {
                    id = existing.id;
                    terminals.signal(id, "SIGINT");
                    await new Promise(r => setTimeout(r, 800));
                }
                else {
                    id = terminals.ensureByPurpose({ purpose, name: purpose, shell, cwd }).id;
                }
                const r = await terminals.execute(id, command, { expect, timeoutMs: 30000 });
                return { terminal: id, purpose, restarted: Boolean(existing), ready: r.matched, output: tail(r.output) };
            }
        }),

        new AITool({
            name: "terminal_read",
            description: "Baca output terakhir sebuah terminal (by `purpose` atau `id`) untuk memeriksa hasil/log.",
            parameters: {
                type: "object",
                properties: {
                    purpose: { type: "string" },
                    id: { type: "string" },
                    tailChars: { type: "number", description: "Jumlah karakter terakhir (default 2000)." }
                }
            },
            execute: async ({ purpose, id, tailChars = 2000 }) => {
                const s = id ? terminals.get(id) : terminals.findByPurpose(purpose);
                if (!s) throw new Error("Terminal tak ditemukan (beri purpose atau id yang benar).");
                return { terminal: s.id, output: tail(s.read(), tailChars) };
            }
        }),

        new AITool({
            name: "terminal_stop",
            description:
                "Kirim Ctrl+C ke terminal (by `purpose` atau `id`) untuk menghentikan proses yang " +
                "sedang berjalan — TANPA menutup terminalnya.",
            parameters: {
                type: "object",
                properties: { purpose: { type: "string" }, id: { type: "string" } }
            },
            execute: async ({ purpose, id }) => {
                const s = id ? terminals.get(id) : terminals.findByPurpose(purpose);
                if (!s) throw new Error("Terminal tak ditemukan.");
                terminals.signal(s.id, "SIGINT");
                return { terminal: s.id, stopped: true };
            }
        })

    ];

}

module.exports = { terminalTools };
