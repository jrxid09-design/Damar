const { AITool } = require("../ai/tools");

const nas = require("./nasService");

/**
 * Tool NAS untuk Damar: status penyimpanan, kesehatan disk (SMART),
 * kontainer Docker, dan share SMB — semua dari mesin nyata.
 */
function nasTools() {

    const fmtGB = n => `${(Number(n) / 1024 ** 3).toFixed(1)} GB`;

    return [

        new AITool({

            name: "nas_status",

            description:
                "Cek kesehatan & status NAS/server: volume disk (terisi/sisa), " +
                "kesehatan SMART, kontainer Docker yang berjalan, share SMB, dan " +
                "jaringan. Pakai untuk 'cek NAS', 'disk penuh?', 'ada disk rusak?'.",

            parameters: { type: "object", properties: {} },

            execute: async () => {

                const s = await nas.status();

                return {
                    host: s.host,
                    platform: s.platform,
                    pool: s.pool ?? null,
                    volumes: (s.volumes ?? []).map(v => ({
                        mount: v.mount,
                        label: v.label,
                        total: fmtGB(v.total),
                        free: fmtGB(v.free),
                        usedPercent: v.usedPercent
                    })),
                    smart: s.smart?.available === false
                        ? { available: false, reason: s.smart.reason }
                        : {
                            available: true,
                            devices: (s.smart?.devices ?? []).map(d => ({
                                name: d.name,
                                health: d.health ?? d.smartStatus ?? null,
                                temperature: d.temperature ?? null
                            }))
                        },
                    docker: s.docker?.available === false
                        ? { available: false }
                        : {
                            available: true,
                            containers: (s.docker?.containers ?? s.docker ?? []).slice(0, 20)
                        },
                    smb: s.smb ?? null,
                    network: s.network ?? null
                };

            }

        }),

        new AITool({

            name: "nas_pools",

            description:
                "Lihat pool penyimpanan NAS dan disk kandidat yang bisa dipakai. " +
                "Pakai saat pengguna bertanya soal pool atau rencana menambah disk.",

            parameters: { type: "object", properties: {} },

            execute: async () => {

                const p = await nas.pools();

                return {
                    supported: p.supported !== false,
                    pools: p.pools ?? [],
                    candidates: (p.candidates ?? []).map(c => ({
                        name: c.name,
                        sizeGB: c.sizeGB,
                        media: c.media
                    }))
                };

            }

        })

    ];

}

module.exports = { nasTools };
