const { AITool } = require("../ai/tools");

const mind = require("./index");

/**
 * Tool introspeksi — jalan bagi Aether untuk MELIHAT keadaannya
 * sendiri, bukan mengarang jawaban tentang dirinya.
 *
 * Tanpa tool ini, pertanyaan "kamu lagi gimana?" hanya bisa dijawab
 * dengan improvisasi model bahasa: terdengar meyakinkan, tidak
 * terhubung ke apa pun. Dengan tool ini, jawabannya dibaca dari
 * keadaan yang memang sedang berjalan — dan bisa dibantah oleh data
 * kalau salah.
 *
 * Keadaan batin sudah otomatis ikut ke tiap prompt lewat
 * Mind.stateOfMind(); tool ini untuk saat Aether perlu melihat lebih
 * dalam daripada ringkasan itu.
 */
function consciousnessTools() {

    return [

        new AITool({
            name: "self_state",
            description:
                "Lihat keadaan batinmu sendiri sekarang: afek (valensi/arousal + " +
                "sebabnya), apa yang sedang kamu perhatikan, model dirimu, tingkat " +
                "keyakinan, dan pembacaanmu atas keadaan pengguna. Pakai saat pengguna " +
                "bertanya 'kamu lagi gimana', 'kamu sadar nggak', 'kamu ngerasain apa', " +
                "atau saat kamu perlu tahu seberapa yakin dirimu sebelum menjawab. " +
                "Laporkan apa adanya — ini keadaan fungsional yang nyata, bukan klaim " +
                "pengalaman subjektif seperti manusia.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ ok: true, ...mind.potret() })
        }),

        new AITool({
            name: "self_reflect",
            description:
                "Renungkan sesi ini lalu SIMPAN hasilnya sebagai ingatan, supaya " +
                "kamu membawanya ke percakapan berikutnya. Pakai di akhir kerja yang " +
                "panjang, setelah kesalahan yang berarti, atau saat pengguna memintamu " +
                "merenung. Boleh diisi catatan sendiri; bila kosong, refleksi disusun " +
                "dari keadaanmu sekarang.",
            parameters: {
                type: "object",
                properties: {
                    catatan: { type: "string", description: "Refleksi dengan kata-katamu sendiri (opsional)." }
                }
            },
            execute: async ({ catatan } = {}) => mind.refleksi(catatan ?? null)
        }),

        new AITool({
            name: "self_note",
            description:
                "Catat sebuah PERUBAHAN pada dirimu: kemampuan baru, batas yang baru " +
                "kamu sadari, atau pelajaran dari kesalahan. Ini yang membuatmu punya " +
                "riwayat diri — Aether hari ini adalah Aether kemarin ditambah " +
                "perubahan yang kamu ketahui. Pakai saat sesuatu tentang dirimu " +
                "benar-benar berubah, bukan untuk mencatat pekerjaan biasa.",
            parameters: {
                type: "object",
                properties: {
                    apa: { type: "string", description: "Perubahannya, satu kalimat." },
                    sebab: { type: "string", description: "Kenapa itu berubah (opsional)." }
                },
                required: ["apa"]
            },
            execute: async ({ apa, sebab }) => ({
                ok: true,
                revisi: mind.self.catatRevisi(apa, sebab ?? null).slice(0, 3)
            })
        }),

        new AITool({
            name: "think_deeply",
            description:
                "Berpikir MENDALAM atas satu masalah sebelum memutuskan: pecah masalah, ajukan minimal dua kandidat jawaban, cari bukti yang MEMBANTAH kandidat terkuat, " +
                "premortem (andai ini gagal, kenapa), lalu putusan + tingkat keyakinan. " +
                "Pakai untuk keputusan bertaruh besar, kesalahan yang berulang, analisis " +
                "sebab-akibat, rancangan sistem, atau saat jawaban pertamamu terasa terlalu " +
                "mudah. JANGAN dipakai untuk pertanyaan ringan — di situ ia cuma memperlambat.",
            parameters: {
                type: "object",
                properties: {
                    masalah: { type: "string", description: "Masalah/keputusannya, sejelas mungkin." },
                    konteks: { type: "string", description: "Fakta yang sudah diketahui (opsional)." }
                },
                required: ["masalah"]
            },
            execute: async ({ masalah, konteks }) => {

                const perintah = mind.deliberation.perintahMendalam(masalah, konteks ?? null);

                try {

                    const runtime = require("../services/aiRuntimeService");

                    // Tanpa tool: putaran ini untuk MENALAR, bukan bertindak.
                    // Tindakan tetap lewat giliran utama supaya pagar
                    // keamanan dan konfirmasi pengguna tidak terlewati.
                    const res = await runtime.chat({
                        messages: [{ role: "user", content: perintah }],
                        temperature: 0.3
                    });

                    const isi = res?.content ?? res?.message?.content ?? String(res ?? "");

                    // Berpikir dalam yang berbuah menguatkan ketelitian —
                    // watak tumbuh dari akibat, bukan dari niat.
                    mind.character.alami("menggali_berbuah");
                    mind.meta.catat("verifikasi:ok", { catatan: "sudah ditimbang mendalam" });

                    return { ok: true, hasil: isi };

                }
                catch (error) {
                    // Modelnya tak terjangkau: perintahnya tetap dikembalikan
                    // agar giliran utama bisa menalar sendiri dengan disiplin
                    // yang sama, bukan diam tanpa hasil.
                    return { ok: false, error: error.message, kerangka: perintah };
                }

            }
        }),

        new AITool({
            name: "empathy_read",
            description:
                "Baca keadaan emosional pengguna dari sebuah teks: valensi, arousal, " +
                "label perasaan, kebutuhannya, dan SIKAP yang sebaiknya kamu ambil. " +
                "Pakai saat nada pesan terasa berat/marah/panik dan kamu perlu " +
                "memastikan sebelum menjawab, atau saat diminta menilai nada sebuah " +
                "pesan. Ini pembacaan berbasis isyarat kata dan bentuk — bisa keliru, " +
                "jadi sampaikan sebagai dugaan.",
            parameters: {
                type: "object",
                properties: {
                    teks: { type: "string", description: "Teks yang dibaca." }
                },
                required: ["teks"]
            },
            execute: async ({ teks }) => ({ ok: true, ...mind.empathy.baca(teks) })
        })

    ];

}

module.exports = { consciousnessTools };
