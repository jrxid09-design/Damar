const { AITool } = require("../../ai/tools");

const MemoryService = require("../services/MemoryService");
const DocumentService = require("../services/DocumentService");
const EntityStore = require("../stores/EntityStore");
const MemoryEngine = require("../core/MemoryEngine");

const { truncate } = require("../util/text");

/**
 * Tool memori yang bisa dipanggil model.
 *
 * Deskripsi ditulis untuk dibaca model, bukan manusia: yang
 * penting jelas KAPAN sebuah tool dipakai, karena itu yang
 * menentukan apakah model memanggilnya di saat yang tepat.
 */
function memoryTools() {

    return [

        new AITool({

            name: "memory_remember",

            description:
                "Simpan informasi ke memori jangka panjang Damar. Pakai ini ketika pengguna " +
                "menyampaikan fakta tentang dirinya, rumahnya, perangkatnya, kebiasaannya, " +
                "atau project yang sedang dikerjakan — sesuatu yang berguna diingat di " +
                "percakapan berikutnya. Jangan dipakai untuk basa-basi atau hal sekali pakai. " +
                "Catatan: fakta pribadi (identitas/preferensi/semantik/prosedur) TIDAK langsung " +
                "tersimpan — diusulkan dan menunggu persetujuan pengguna. Sampaikan itu apa adanya.",

            parameters: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "Fakta yang disimpan, ditulis lengkap dan berdiri sendiri tanpa perlu konteks percakapan."
                    },
                    type: {
                        type: "string",
                        enum: ["episodic", "semantic", "preference", "procedural"],
                        description: "episodic=peristiwa berwaktu, semantic=fakta umum, preference=selera/kebiasaan, procedural=cara melakukan sesuatu."
                    },
                    importance: {
                        type: "number",
                        description: "0 sampai 1. Identitas pemilik dan hal yang sering dirujuk mendekati 1."
                    },
                    entities: {
                        type: "array",
                        items: { type: "string" },
                        description: "Nama orang, kendaraan, ruangan, perangkat, atau project yang disebut."
                    }
                },
                required: ["content"]
            },

            execute: async ({ content, type, importance, entities }) => {

                // Lewat facade → digerbang Governance: tier "ask" jadi proposal,
                // tier "auto" (episodic) commit langsung.
                const result = await MemoryEngine.remember(
                    content,
                    { type: type ?? "semantic", importance, entities: Array.isArray(entities) ? entities : [] },
                    MemoryEngine.context({ writer: "chat" })
                );

                if (result && result.status === "pending") {
                    return {
                        saved: false,
                        proposed: true,
                        proposalId: result.proposal.id,
                        status: "pending",
                        note: "Diusulkan ke memori jangka panjang, menunggu persetujuan pengguna sebelum disimpan permanen."
                    };
                }

                return {
                    saved: true,
                    id: result.id,
                    reinforced: result.reinforced,
                    entities: (result.entities || []).map(entity => entity.name ?? entity)
                };

            }

        }),

        new AITool({

            name: "memory_recall",

            description:
                "Cari di memori jangka panjang Damar. Pakai ini SEBELUM menjawab bila " +
                "pertanyaan menyinggung hal yang pernah dibicarakan, kondisi rumah, " +
                "perangkat, project, atau isi dokumen yang pernah dibaca. Lebih baik " +
                "mencari lalu tidak menemukan apa-apa daripada menebak.",

            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Apa yang dicari, dalam bahasa alami."
                    },
                    type: {
                        type: "string",
                        enum: ["episodic", "semantic", "preference", "procedural"],
                        description: "Batasi ke satu jenis memori bila relevan."
                    },
                    limit: {
                        type: "number",
                        description: "Jumlah hasil, default 6."
                    }
                },
                required: ["query"]
            },

            execute: async ({ query, type, limit }) => {

                const result = await MemoryService.recall(query, {
                    limit: limit ?? 6,
                    types: type ? [type] : null
                });

                return {
                    found: result.items.length,
                    memories: result.items.map(item => ({
                        id: item.id,
                        type: item.type,
                        content: item.content,
                        when: item.occurredAt,
                        source: item.source,
                        entities: item.entities.map(entity => entity.name)
                    })),
                    documents: result.documents.map(doc => ({
                        title: doc.title,
                        section: doc.heading,
                        excerpt: doc.excerpt
                    }))
                };

            }

        }),

        new AITool({

            name: "memory_forget",

            description:
                "Lupakan satu memori berdasarkan id. Pakai hanya bila pengguna secara " +
                "eksplisit meminta melupakan sesuatu, atau memori itu terbukti salah. " +
                "Ini melupakan LUNAK: memori disembunyikan dari recall tapi datanya tetap ada.",

            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "Id memori dari hasil memory_recall." }
                },
                required: ["id"]
            },

            execute: async ({ id }) => {
                await MemoryEngine.forget(Number(id));
                return {
                    forgotten: true, soft: true,
                    note: "Dilupakan lunak — hilang dari recall, data tetap tersimpan dan bisa dipulihkan."
                };
            }

        }),

        new AITool({

            name: "memory_entities",

            description:
                "Lihat entitas yang dikenal Damar — orang, kendaraan, ruangan, perangkat, " +
                "project. Pakai untuk memeriksa apakah sesuatu sudah dikenal sebelum " +
                "bertanya ulang kepada pengguna.",

            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Nama atau sebagian nama." },
                    kind: {
                        type: "string",
                        enum: ["person", "vehicle", "room", "device", "project",
                               "place", "organization", "file", "pet", "other"]
                    }
                }
            },

            execute: async ({ query, kind }) => {

                const entities = await EntityStore.list({
                    query: query ?? null,
                    kind: kind ?? null,
                    limit: 25
                });

                const detailed = [];

                for (const entity of entities) {

                    detailed.push({
                        id: entity.id,
                        kind: entity.kind,
                        name: entity.name,
                        aliases: await EntityStore.aliases(entity.id),
                        attributes: entity.attributes,
                        lastSeen: entity.lastSeenAt
                    });

                }

                return { count: detailed.length, entities: detailed };

            }

        }),

        new AITool({

            name: "memory_documents",

            description:
                "Daftar dokumen yang sudah dibaca Damar (manual, datasheet, catatan). " +
                "Pakai untuk memberi tahu pengguna sumber apa saja yang tersedia.",

            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Saring berdasarkan judul." }
                }
            },

            execute: async ({ query }) => {

                const result = await DocumentService.list({
                    query: query ?? null,
                    limit: 30
                });

                return {
                    total: result.total,
                    documents: result.items.map(document => ({
                        id: document.id,
                        title: document.title,
                        type: document.mediaType,
                        chunks: document.chunkCount,
                        preview: truncate(document.uri, 80),
                        ingestedAt: document.ingestedAt
                    }))
                };

            }

        })

    ];

}

module.exports = { memoryTools };
