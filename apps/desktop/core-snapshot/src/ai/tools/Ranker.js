const toolStats = require("./ToolStats");

/**
 * TOOL RANKER — pemeringkat kandidat, deterministik.
 *
 * Retriever menemukan yang MENYINGGUNG; ranker memutuskan yang
 * TERBAIK. Bobot tambahan di atas skor retrieval:
 *
 *   keandalan historis   ±2    (baru setelah ≥5 sampel — konservatif)
 *   eksternal (MCP)      −0.5  (ambigu → pilih milik sendiri)
 *   destruktif + voice   −1    (kanal lisan lebih hati-hati)
 *   latensi tinggi       −0.5
 *
 * Untuk pesan + keadaan registry (termasuk stats) yang sama, hasil
 * selalu sama: tidak ada Math.random, tidak ada Date.now() dalam
 * penilaian; seri diputus abjad nama. selectionReason berupa label
 * teknis ("kw:lampu", "reliability") — BUKAN reasoning model.
 */

const RELIABILITY_MIN_SAMPLES = 5;

function applyBoosts(candidates, { channel = null, pastNonAction = false } = {}) {

    return candidates.map(candidate => {

        let score = candidate.score;
        const reasons = [...candidate.reasons];

        // NON-AKSI LAMPAU: ucapan syukur atas kejadian selesai ("makasih
        // sudah matiin lampu tadi") bukan perintah. Kapabilitas berefek
        // ditindas keras — deterministik, bukan skor halus.
        if (pastNonAction && candidate.record.sideEffects) {
            score *= 0.15;
            reasons.push("past-non-action");
        }

        const reliability = toolStats.reliability(candidate.record.name);

        if (reliability !== null) {
            if (reliability >= 0.8) {
                score += 1.5;
                reasons.push(`reliability:${reliability.toFixed(2)}`);
            }
            else if (reliability <= 0.4) {
                score -= 2;
                reasons.push(`unreliable:${reliability.toFixed(2)}`);
            }
        }

        if (candidate.record.external) {
            score -= 0.5;
            reasons.push("external");
        }

        if (candidate.record.destructive && channel === "voice") {
            score -= 1;
            reasons.push("destructive-voice");
        }

        const avgMs = toolStats.avgMs(candidate.record.name);

        if (avgMs !== null && avgMs > 30_000) {
            score -= 0.5;
            reasons.push("slow");
        }

        return {
            ...candidate,
            score: Math.round(score * 100) / 100,
            reasons
        };

    }).sort((a, b) =>
        b.score - a.score ||
        String(a.record.name).localeCompare(String(b.record.name))
    );

}

/**
 * Saring kelayakan: peran & kanal. Dipisah dari skor karena ini
 * PAGAR, bukan preferensi — yang ditolak tidak boleh masuk walau
 * skornya tertinggi.
 */
function filterEligible(candidates, { role = null, channel = null } = {}) {

    return candidates.filter(({ record }) => {

        if (record.roles && (!role || !record.roles.includes(role))) return false;

        if (record.channels && (!channel || !record.channels.includes(channel))) return false;

        return true;

    });

}

module.exports = { applyBoosts, filterEligible, RELIABILITY_MIN_SAMPLES };

