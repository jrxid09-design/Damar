const { AITool } = require("../ai/tools");

const { executeCanonicalAction, contextFromExecution } = require("./canonicalActionClient");
const TERMINAL = "damar.terminal";

/**
 * Tool AI untuk Terminal Runtime.
 *
 * Prinsip (ditegakkan lewat deskripsi + terminal_run/restart):
 * Damar TIDAK spawn shell sementara — ia cari terminal berdasarkan
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
            execute: async (_args, exec) => executeCanonicalAction({
                context: contextFromExecution(exec?.ingress ?? exec),
                capabilityId: TERMINAL,
                operation: "list",
                arguments: { purpose: "__list__" }
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
                    purpose: { type: "string", description: "Kunci stabil terminal, mis. 'docker','build','python'." },
                    command: { type: "string", description: "Perintah yang dijalankan." },
                    expect: { type: "string", description: "Regex output yang ditunggu (opsional)." },
                    shell: { type: "string", description: "powershell|cmd|wsl|gitbash|bash (opsional)." },
                    cwd: { type: "string", description: "Direktori kerja (opsional)." }
                },
                required: ["purpose", "command"]
            },
            execute: async ({ purpose, command, expect, shell, cwd }, exec) => {
                return executeCanonicalAction({ context: contextFromExecution(exec?.ingress ?? exec), capabilityId: TERMINAL, operation: "run", arguments: { purpose, command, expect, shell, cwd } });
            }
        }),

        new AITool({
            name: "terminal_restart",
            description:
                "Mulai ulang layanan di terminalnya: cari terminal by `purpose`, kirim Ctrl+C, " +
                "lalu jalankan `command` lagi dan tunggu siap (`expect`). Buat baru bila belum " +
                "ada. Contoh: purpose='build', command='npm run build', expect='compiled'.",
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
            execute: async ({ purpose, command, expect, shell, cwd }, exec) => {
                return executeCanonicalAction({ context: contextFromExecution(exec?.ingress ?? exec), capabilityId: TERMINAL, operation: "restart", arguments: { purpose, command, expect, shell, cwd } });
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
            execute: async ({ purpose, id, tailChars = 2000 }, exec) => {
                return executeCanonicalAction({ context: contextFromExecution(exec?.ingress ?? exec), capabilityId: TERMINAL, operation: "read", arguments: { purpose, id, tailChars } });
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
            execute: async ({ purpose, id }, exec) => {
                return executeCanonicalAction({ context: contextFromExecution(exec?.ingress ?? exec), capabilityId: TERMINAL, operation: "stop", arguments: { purpose, id } });
            }
        })

    ];

}

module.exports = { terminalTools };
