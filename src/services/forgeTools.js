const { AITool } = require("../ai/tools");

const forge = require("./toolForge");

/**
 * Tool yang membuat Damar bisa menambah kemampuannya sendiri.
 *
 * Alur yang diharapkan (ditegaskan lewat deskripsi tool):
 *   1. create_tool  → menyimpan DRAFT, menampilkan apa yang akan
 *      dilakukan tool + peringatan risiko.
 *   2. Pengguna menyetujui (bisa lewat percakapan atau Console).
 *   3. activate_tool → tool jadi aktif dan bisa dipanggil.
 *
 * activate_tool hanya boleh dipanggil setelah pengguna
 * mengonfirmasi secara eksplisit — ini gerbang keamanannya.
 */
function forgeTools() {

    return [

        new AITool({

            name: "create_tool",

            description:
                "Buat SKILL baru (disebut juga tool/plugin/kemampuan) untuk memperluas " +
                "kemampuan Damar. WAJIB dipakai setiap kali pengguna minta dibuatkan " +
                "skill/tool/plugin atau butuh kemampuan yang belum ada (mis. 'buatkan " +
                "skill untuk cek ping ke sebuah host'). JANGAN menuliskan kode di dalam " +
                "chat — buat skill-nya lewat tool ini. Skill disimpan sebagai DRAFT dan " +
                "BELUM aktif — setelah membuatnya, jelaskan singkat apa yang dilakukan " +
                "skill dan sebutkan peringatan risiko (bila ada), lalu TANYA apakah mau " +
                "diaktifkan. Jangan mengaktifkan tanpa persetujuan eksplisit.",

            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "Id plugin, huruf kecil dengan strip, mis. 'ping-host'."
                    },
                    name: {
                        type: "string",
                        description: "Nama tampilan, mis. 'Ping Host'."
                    },
                    description: {
                        type: "string",
                        description: "Penjelasan singkat fungsi tool."
                    },
                    tool_name: {
                        type: "string",
                        description: "Nama fungsi yang dipanggil model, camelCase, mis. 'pingHost'."
                    },
                    parameters: {
                        type: "object",
                        description:
                            "Parameter tool sebagai peta { nama: { type, description, required } }. " +
                            "type boleh string/number/boolean."
                    },
                    code: {
                        type: "string",
                        description:
                            "Isi BADAN fungsi execute(context, args) dalam JavaScript (Node). " +
                            "Gunakan `return { ... }` untuk hasil. Boleh memakai require Node " +
                            "bawaan dan fetch. Jangan menulis definisi fungsi/kelas — cukup " +
                            "badan-nya. Contoh: 'const r = await fetch(args.url); return { ok: r.ok };'"
                    }
                },
                required: ["id", "name", "tool_name", "code"]
            },

            execute: async (args) => {

                const result = forge.create({
                    id: args.id,
                    name: args.name,
                    description: args.description ?? "",
                    origin: "damar",
                    tool: {
                        name: args.tool_name,
                        description: args.description ?? "",
                        parameters: normalizeParams(args.parameters),
                        code: args.code
                    }
                });

                return {
                    created: true,
                    id: result.id,
                    status: result.status,
                    risks: result.risks,
                    note: result.status === "draft"
                        ? "Draft tersimpan tapi BELUM aktif. Minta pengguna menyetujui, " +
                          "lalu panggil activate_tool dengan id ini."
                        : "Tool langsung aktif (mode auto-approve)."
                };

            }

        }),

        new AITool({

            name: "activate_tool",

            description:
                "Aktifkan tool draft agar bisa dipakai. HANYA panggil ini setelah pengguna " +
                "secara eksplisit menyetujui (mis. berkata 'ya, aktifkan'). Jangan " +
                "mengaktifkan atas inisiatif sendiri.",

            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Id draft dari create_tool." }
                },
                required: ["id"]
            },

            execute: async ({ id }) => {

                const result = forge.approve(id);

                return {
                    activated: true,
                    id: result.id,
                    tools: result.tools,
                    note: `Tool '${id}' aktif dan siap dipanggil sekarang.`
                };

            }

        }),

        new AITool({

            name: "list_my_tools",

            description:
                "Lihat tool buatan sendiri (yang aktif maupun masih draft). Pakai untuk " +
                "mengecek apa yang sudah ada sebelum membuat yang baru, atau melihat draft " +
                "yang menunggu persetujuan.",

            parameters: {
                type: "object",
                properties: {}
            },

            execute: async () => {

                const { active, drafts } = forge.list();

                return {
                    active: active.map(t => ({ id: t.id, name: t.name, description: t.description })),
                    drafts: drafts.map(t => ({
                        id: t.id, name: t.name, risks: t.risks
                    }))
                };

            }

        }),

        new AITool({

            name: "remove_tool",

            description:
                "Hapus tool buatan sendiri berdasarkan id. Hanya untuk tool user/draft — " +
                "tool bawaan tidak bisa dihapus. Konfirmasi dulu ke pengguna sebelum menghapus.",

            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: "Id tool yang dihapus." }
                },
                required: ["id"]
            },

            execute: async ({ id }) => ({
                removed: forge.remove(id)
            })

        })

    ];

}

/**
 * Model kadang mengirim parameter sebagai skema JSON penuh, kadang
 * peta sederhana. Diseragamkan ke bentuk peta yang dipakai plugin.
 */
function normalizeParams(parameters) {

    if (!parameters || typeof parameters !== "object") {
        return {};
    }

    // Bentuk skema JSON: { type:'object', properties:{...} }
    if (parameters.type === "object" && parameters.properties) {

        const required = new Set(parameters.required ?? []);
        const out = {};

        for (const [key, spec] of Object.entries(parameters.properties)) {
            out[key] = {
                type: spec.type ?? "string",
                description: spec.description ?? "",
                required: required.has(key)
            };
        }

        return out;

    }

    return parameters;

}

module.exports = { forgeTools };
