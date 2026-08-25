const { AITool } = require("../ai/tools");

const WorldModel = require("./WorldModel");
const EntityStore = require("../memory/stores/EntityStore");
const RelationService = require("../memory/services/RelationService");

/**
 * Tool "tahu tempat sendiri" dan "tahu siapa terhubung dengan siapa".
 *
 * Keduanya membaca; tidak ada yang mengubah apa pun.
 */
function worldTools() {

    return [

        new AITool({

            name: "world_describe",

            description:
                "Gambaran utuh lingkungan Aether saat ini: mesin, memori, disk, layanan " +
                "(layanan lokal), model yang termuat, dan keadaan rem keselamatan — beserta " +
                "KAPAN masing-masing terakhir diperiksa. Pakai saat pengguna bertanya tentang " +
                "kondisi sistem, kapasitas, atau apakah sesuatu sedang berjalan.",

            parameters: {
                type: "object",
                properties: {
                    fresh: {
                        type: "boolean",
                        description: "Paksa periksa ulang, jangan pakai hasil semenit terakhir."
                    }
                }
            },

            execute: async ({ fresh } = {}) => WorldModel.describe({ fresh: Boolean(fresh) })

        }),

        new AITool({

            name: "memory_related",

            description:
                "Telusuri siapa/apa yang BERHUBUNGAN dengan sesuatu di memori — orang, " +
                "kendaraan, ruangan, perangkat — berdasarkan seberapa sering mereka disebut " +
                "bersama. Pakai untuk pertanyaan relasi ('siapa yang sering bersama X', " +
                "'apa yang terkait dengan Y'), bukan untuk mencari satu fakta.",

            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Nama entitas, mis. 'Budi' atau 'ruang tamu'." },
                    depth: { type: "number", description: "1 = langsung saja, 2 = termasuk lewat perantara (bawaan 2)." }
                },
                required: ["name"]
            },

            execute: async ({ name, depth }) => {

                const entitas = await EntityStore.findByName?.(name)
                    ?? await EntityStore.resolve?.(name)
                    ?? null;

                if (!entitas?.id) {
                    return {
                        ok: false,
                        note: `Tidak ada entitas bernama "${name}" di memori. Jangan menebak hubungannya.`
                    };
                }

                const hasil = await RelationService.related(entitas.id, {
                    depth: Number(depth) || 2
                });

                return {
                    ok: true,
                    entitas: { id: entitas.id, name: entitas.name, kind: entitas.kind },
                    langsung: hasil.direct,
                    lewatPerantara: hasil.indirect,
                    note:
                        "Hubungan diukur dari seberapa sering disebut BERSAMA dalam satu memori — " +
                        "kaitan lemah, bukan pernyataan bahwa mereka benar-benar berhubungan. " +
                        "Sampaikan sebagai pola yang terlihat, bukan sebagai fakta."
                };

            }

        })

    ];

}

module.exports = { worldTools };
