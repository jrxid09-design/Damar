const { AITool } = require("../ai/tools");

const forge = require("./toolForge");

/**
 * Tool yang membuat Damar bisa menambah kemampuannya sendiri.
 *
 * Alur yang diharapkan (ditegaskan lewat deskripsi tool):
 *   1. create_tool  → menyimpan DRAFT, menampilkan apa yang akan
 *      dilakukan tool + peringatan risiko.
 *   2. Pengguna menyetujui (bisa lewat percakapan atau Console).
 *   3. activate_tool → mencatat PERSETUJUAN (status).
 *
 * Sejak remediasi jalur-kedua W8, persetujuan BUKAN aktivasi: artefak forge
 * tetap di karantina, tidak dipindahkan ke root plugin yang bisa dimuat, dan
 * tidak ada kode yang dijalankan. Tool hasil generate baru bisa dipanggil
 * setelah terdaftar lewat jalur kanonik (Manager → ActionIntent → Authority →
 * Capability). Karena itu tidak ada tool di file ini yang boleh mengklaim
 * sebuah tool "aktif dan siap dipanggil".
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
                    activated: false,
                    note: result.status === "draft"
                        ? "Draft tersimpan tapi BELUM aktif. Minta pengguna menyetujui " +
                          "(activate_tool mencatat persetujuan; eksekusi tetap menunggu " +
                          "registrasi kanonik)."
                        : "Draft tersimpan dengan status persetujuan; BELUM dimuat dan " +
                          "tidak bisa dipanggil sampai terdaftar di jalur kanonik."
                };

            }

        }),

        new AITool({

            name: "activate_tool",

            description:
                "Setujui tool draft (status persetujuan). Sejak remediasi jalur-kedua W8 " +
                "persetujuan TIDAK mengaktifkan eksekusi: tool hasil generate baru benar-benar " +
                "bisa dipanggil setelah terdaftar di jalur kanonik. HANYA panggil ini setelah " +
                "pengguna secara eksplisit menyetujui (mis. berkata 'ya, setujui').",

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
                    approved: true,
                    activated: false,
                    canonicalRequired: result.canonicalRequired === true,
                    id: result.id,
                    tools: result.tools,
                    note: `Draft '${id}' disetujui secara status, TAPI belum dimuat/dieksekusi: ` +
                        `aktivasi menunggu registrasi kanonik (Manager -> ActionIntent -> Authority -> Capability). ` +
                        `Jangan mengklaim tool ini bisa dipanggil sekarang.`
                };

            }

        }),

        new AITool({

            name: "list_my_tools",

            description:
                "Lihat tool buatan sendiri: mana yang BENAR-BENAR aktif, mana yang baru " +
                "disetujui tapi belum dimuat (menunggu registrasi kanonik), dan mana yang " +
                "masih draft. Jangan menyebut sesuatu aktif kalau belum dimuat.",

            parameters: {
                type: "object",
                properties: {}
            },

            execute: async () => {

                const { active = [], drafts = [] } = forge.list();

                // Hanya entri yang benar-benar dimuat (activated === true) yang
                // boleh disebut aktif. Yang sekadar disetujui — baik yang sudah
                // diinstal maupun yang masih di karantina forge — masuk bucket
                // approvedNotLoaded supaya tidak pernah dilaporkan sebagai tool
                // yang bisa dipanggil.
                const isActivated = (t) => t?.activated === true && t?.status === "active";
                const isApproved = (t) => !isActivated(t) && t?.status === "approved";
                const live = active.filter(isActivated);
                const approvedNotLoaded = [...active, ...drafts].filter(isApproved);
                const pendingDrafts = drafts.filter(t => t?.status !== "approved");

                return {
                    active: live.map(t => ({ id: t.id, name: t.name, description: t.description })),
                    approvedNotLoaded: approvedNotLoaded.map(t => ({
                        id: t.id,
                        name: t.name,
                        status: t.status,
                        canonicalRequired: t.canonicalRequired === true
                    })),
                    drafts: pendingDrafts.map(t => ({
                        id: t.id, name: t.name, risks: t.risks
                    })),
                    note: approvedNotLoaded.length > 0
                        ? "approvedNotLoaded = disetujui tapi BELUM dimuat/dieksekusi; aktivasi menunggu registrasi kanonik."
                        : null
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
