const { AITool } = require("../ai/tools");

const immich = require("./immichService");
const face = require("./faceService");
const deviceService = require("./deviceService");

/**
 * Tool "orang & wajah" untuk Damar:
 *   - find_people / search_photos → galeri Immich (siapa & foto apa)
 *   - identify_face → kenali siapa di snapshot kamera (CCTV)
 */
function peopleTools() {

    return [

        new AITool({
            name: "find_people",
            description:
                "Lihat daftar orang (wajah bernama) yang dikenal di galeri Immich. " +
                "Pakai untuk cek siapa saja yang dikenali, atau menemukan orang " +
                "sebelum mencari fotonya.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Saring per nama (opsional)." }
                }
            },
            execute: async ({ name }) => {
                const people = name ? await immich.findPerson(name) : await immich.people();
                return { count: people.length, people: people.map(p => ({ id: p.id, name: p.name })) };
            }
        }),

        new AITool({
            name: "search_photos",
            description:
                "Cari foto di galeri Immich. Bisa lewat deskripsi ('foto saat ke Bandung " +
                "naik motor') dan/atau nama orang ('semua foto ibu'). Immich memakai " +
                "pengenalan wajah & pencarian cerdas. " +
                "Hasil mengembalikan id aset yang bisa dipakai send_immich_photo.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Deskripsi/adegan yang dicari." },
                    person: { type: "string", description: "Nama orang (opsional)." },
                    limit: { type: "number", description: "Maksimum hasil (default 20)." }
                }
            },
            execute: async ({ query, person, limit }) => {

                let results;

                if (person) {
                    const matches = await immich.findPerson(person);
                    if (matches.length === 0) {
                        return { found: 0, note: `Orang bernama "${person}" tidak ditemukan di Immich.` };
                    }
                    results = await immich.searchByPerson(matches.map(m => m.id), { query, limit });
                }
                else if (query) {
                    results = await immich.searchSmart(query, { limit });
                }
                else {
                    return { found: 0, note: "Sebutkan deskripsi atau nama orang." };
                }

                return {
                    found: results.length,
                    photos: results.slice(0, 20).map(a => ({
                        id: a.id,
                        takenAt: a.takenAt,
                        place: a.place,
                        fileName: a.fileName,
                        thumbnail: a.thumbnail
                    }))
                };

            }
        }),

        new AITool({
            name: "identify_face",
            description:
                "Kenali SIAPA yang terlihat di sebuah kamera/CCTV (bukan sekadar deskripsi). " +
                "Pakai saat pengguna bertanya 'siapa di depan pintu', 'kenali orang di " +
                "ruang tamu'. Butuh layanan wajah terkonfigurasi.",
            parameters: {
                type: "object",
                properties: {
                    camera: { type: "string", description: "id/nama kamera." }
                },
                required: ["camera"]
            },
            execute: async ({ camera }) => {

                const cams = deviceService.cameras();
                const cam = cams.find(c =>
                    c.id === camera || c.label?.toLowerCase() === String(camera).toLowerCase());

                if (!cam) {
                    return { ok: false, error: `Kamera "${camera}" tidak ditemukan.` };
                }

                // Ambil snapshot lalu cocokkan wajah.
                const res = await fetch(cam.snapshotUrl, { headers: cam.headers ?? {} });
                if (!res.ok) {
                    return { ok: false, error: `Snapshot gagal (${res.status})` };
                }
                const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");

                const { faces } = await face.recognize(b64);

                return { ok: true, camera: cam.id, summary: face.describe(faces), faces };

            }
        })

    ];

}

module.exports = { peopleTools };
