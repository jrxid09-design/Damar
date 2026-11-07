const { AITool } = require("../ai/tools");

const vision = require("./visionService");
const deviceService = require("./deviceService");

/**
 * Tool vision untuk Damar — membuatnya bisa "melihat".
 *
 * "Lihat dapur", "ada siapa di ruang tamu?", "apakah kompor mati?"
 * → Damar mengambil snapshot kamera bernama lalu menganalisisnya
 * dengan model vision.
 */
function visionTools() {

    return [

        new AITool({

            name: "list_cameras",

            description:
                "Lihat daftar kamera/CCTV yang terdaftar beserta id-nya. Pakai untuk " +
                "menemukan kamera yang tepat sebelum see_camera.",

            parameters: { type: "object", properties: {} },

            execute: async () => ({
                cameras: deviceService.cameras().map(c => ({
                    id: c.id, label: c.label, enabled: c.enabled
                }))
            })

        }),

        new AITool({

            name: "see_camera",

            description:
                "Lihat & analisis kondisi terkini dari sebuah kamera/CCTV. Pakai saat " +
                "pengguna bertanya tentang keadaan suatu ruangan/area (mis. 'ada siapa di " +
                "ruang tamu', 'lihat dapur', 'apakah pagar tertutup'). Sebutkan id/nama " +
                "kamera; kalau tak tahu, panggil list_cameras dulu.",

            parameters: {
                type: "object",
                properties: {
                    camera: { type: "string", description: "id atau nama kamera, mis. 'dapur'" },
                    question: {
                        type: "string",
                        description: "Yang ingin diketahui, mis. 'ada berapa orang?' (opsional)"
                    }
                },
                required: ["camera"]
            },

            execute: async ({ camera, question }, ctx) => {

                const cams = deviceService.cameras();

                const cam = cams.find(c =>
                    c.id === camera ||
                    c.label?.toLowerCase() === String(camera).toLowerCase()
                );

                if (!cam) {
                    return {
                        ok: false,
                        error: `Kamera "${camera}" tidak ditemukan. Tersedia: ${cams.map(c => c.id).join(", ") || "(belum ada)"}`
                    };
                }

                const result = await vision.analyzeUrl({
                    url: cam.snapshotUrl,
                    headers: cam.headers ?? {},
                    prompt: question,
                    // N2-FINAL: giliran visi mewarisi pemanggil tool.
                    exec: ctx?.exec ?? null,
                    // D-FINAL: URL dari REGISTRY kamera milik pemilik —
                    // satu-satunya alasan kebijakan trusted-lan sah.
                    policy: "trusted-lan"
                });

                return {
                    ok: true,
                    camera: cam.id,
                    seen: result.text,
                    model: result.model
                };

            }

        })

    ];

}

module.exports = { visionTools };
