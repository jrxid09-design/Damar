const { AITool } = require("../../ai/tools");

const buildMemory = require("../buildMemory");

/**
 * Tool "ingatan tentang diri sendiri".
 *
 * Damar tahu keadaannya sekarang, tetapi tidak tahu bagaimana ia
 * sampai ke sana. Dua tool ini memberinya akses ke jurnal rekayasa:
 * keputusan apa yang diambil, mengapa, dan bagaimana dibuktikan.
 *
 * Gunanya dua: menjawab pertanyaan pemilik tentang dirinya, dan
 * menjadi pijakan saat memulihkan diri — sebuah gejala yang pernah
 * ditangani tidak perlu diselidiki dari nol.
 */
function buildTools() {

    return [

        new AITool({

            name: "build_recall",

            description:
                "Ingat BAGAIMANA Damar dibangun atau dikonfigurasi: keputusan arsitektur, " +
                "alasan di baliknya, berkas yang terlibat, dan cara pembuktiannya. Pakai ini " +
                "ketika pengguna bertanya kenapa sesuatu dirancang begini, ketika kamu perlu " +
                "memahami bagian dirimu sendiri sebelum mengubahnya, atau saat memulihkan diri " +
                "dari gangguan — panggil PALING AWAL agar tidak menyelidiki ulang hal yang " +
                "sudah pernah diputuskan.",

            parameters: {
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description: "Bagian atau gejala yang ditanyakan, mis. 'kill switch', 'kenapa terminal_run diblokir', 'jejak audit'."
                    },
                    limit: {
                        type: "number",
                        description: "Jumlah catatan maksimum (bawaan 5)."
                    }
                },
                required: ["topic"]
            },

            execute: async ({ topic, limit }) =>
                buildMemory.recall(topic, { limit: Number(limit) || 5 })

        }),

        new AITool({

            name: "build_remember",

            description:
                "Simpan satu keputusan rekayasa tentang Damar sendiri, SETELAH terbukti " +
                "bekerja. Isi `why` dengan alasan sebenarnya — perubahan berkas bisa dibaca " +
                "ulang dari git kapan saja, tetapi alasan sebuah keputusan hanya ada saat " +
                "keputusan itu dibuat. Bukan untuk mencatat peristiwa biasa: setiap eksekusi " +
                "tool sudah tercatat di jejak audit.",

            parameters: {
                type: "object",
                properties: {
                    area: { type: "string", description: "Bagian Damar, mis. 'keselamatan', 'memori', 'console'." },
                    change: { type: "string", description: "Apa yang berubah." },
                    why: { type: "string", description: "Mengapa — akar masalah atau pertimbangannya." },
                    files: { type: "array", items: { type: "string" }, description: "Berkas utama yang tersentuh." },
                    verification: { type: "string", description: "Bagaimana dibuktikan benar." },
                    risks: { type: "string", description: "Yang masih tersisa atau bisa salah." }
                },
                required: ["change", "why"]
            },

            execute: async (entry) => buildMemory.record(entry)

        })

    ];

}

module.exports = { buildTools };
