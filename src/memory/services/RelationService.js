const { database } = require("../db");

/**
 * Penalaran lintas-relasi di graf memori (§276).
 *
 * Damar menyimpan entitas dan memori yang menyebut mereka, tetapi
 * tidak pernah menelusuri hubungannya. Akibatnya ia bisa menjawab
 * "siapa Budi" dari satu catatan, dan tetap tidak tahu bahwa Budi
 * dan mobil biru itu muncul bersama enam kali — pengetahuan yang
 * sudah ada di basis datanya sendiri.
 *
 * Dua entitas dianggap berhubungan bila disebut dalam memori yang
 * sama. Ini kaitan lemah, dan disebut demikian: banyaknya kemunculan
 * bersama dilaporkan apa adanya agar model dapat menilai, bukan
 * disulap menjadi klaim "berhubungan" tanpa ukuran.
 */

/**
 * Entitas yang berhubungan dengan sebuah entitas, satu lompatan.
 *
 * @param {number} entityId
 * @param {object} [opts]
 * @param {number} [opts.limit]   jumlah maksimum tetangga
 * @param {number} [opts.minShared] ambang kemunculan bersama
 */
async function neighbours(entityId, { limit = 10, minShared = 1 } = {}) {

    const rows = await database.all(
        `SELECT e.id, e.kind, e.name, COUNT(*) AS shared
           FROM memory_entities a
           JOIN memory_entities b ON b.memory_id = a.memory_id
                                 AND b.entity_id <> a.entity_id
           JOIN entities e ON e.id = b.entity_id
          WHERE a.entity_id = ?
            AND e.merged_into IS NULL
          GROUP BY e.id
         HAVING shared >= ?
          ORDER BY shared DESC, e.importance DESC
          LIMIT ?`,
        [entityId, minShared, limit]
    );

    return rows.map(r => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        shared: r.shared,
        basis: `disebut bersama dalam ${r.shared} memori`
    }));

}

/**
 * Telusuri dua lompatan: kenalan dari kenalan.
 *
 * Yang sudah menjadi tetangga langsung TIDAK diulang di lapis kedua —
 * kalau tidak, hubungan terdekat akan tampak dua kali dan terbaca
 * lebih kuat daripada sebenarnya.
 */
async function related(entityId, { limit = 10, depth = 2 } = {}) {

    const langsung = await neighbours(entityId, { limit });

    if (depth < 2 || !langsung.length) {
        return { entityId, direct: langsung, indirect: [] };
    }

    const sudah = new Set([Number(entityId), ...langsung.map(n => n.id)]);

    const tidakLangsung = new Map();

    for (const n of langsung) {

        for (const m of await neighbours(n.id, { limit })) {

            if (sudah.has(m.id)) continue;

            const ada = tidakLangsung.get(m.id);

            if (ada) {
                ada.shared += m.shared;
                ada.via.push(n.name);
            }
            else {
                tidakLangsung.set(m.id, { ...m, via: [n.name] });
            }

        }

    }

    const indirect = [...tidakLangsung.values()]
        .sort((a, b) => b.shared - a.shared)
        .slice(0, limit)
        .map(m => ({
            ...m,
            basis: `terhubung lewat ${m.via.join(", ")}`
        }));

    return { entityId, direct: langsung, indirect };

}

/** Memori yang menyebut kedua entitas — bukti hubungannya. */
async function evidence(aId, bId, { limit = 5 } = {}) {

    const rows = await database.all(
        `SELECT m.id, m.content, m.occurred_at AS occurredAt
           FROM memories m
           JOIN memory_entities x ON x.memory_id = m.id AND x.entity_id = ?
           JOIN memory_entities y ON y.memory_id = m.id AND y.entity_id = ?
          WHERE m.valid_until IS NULL
          ORDER BY m.occurred_at DESC
          LIMIT ?`,
        [aId, bId, limit]
    );

    return rows;

}

module.exports = { neighbours, related, evidence };
