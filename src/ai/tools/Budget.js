const SchemaMinimizer = require("./SchemaMinimizer");

/**
 * TOOL BUDGET — anggaran disclosure yang context-aware.
 *
 * Bukan "32 tool" mati: anggaran diturunkan dari jendela konteks
 * model AKTIF. Yang dihitung:
 *
 *   sisa konteks ≈ window − (system + riwayat + memori) − cadangan
 *   anggaran skema ≈ 35% dari sisa, dibatasi [600 .. 6000] token
 *
 * Model 8K mendapat sedikit tool berskema gundul; model 128K/1M
 * boleh membawa lebih banyak dengan deskripsi utuh. Tidak ada nama
 * model atau provider yang di-hardcode — hanya ukuran konteks.
 */

const RESERVE_TOKENS = 1024;          // ruang jawaban model
const SCHEMA_SHARE = 0.35;            // porsi sisa konteks utk definisi tool
const MIN_SCHEMA_BUDGET = 600;
const MAX_SCHEMA_BUDGET = 6000;

/** Profil verbositas per ukuran jendela (token). */
function profileFor(contextTokens) {

    const ctx = Number.isFinite(contextTokens) && contextTokens > 0
        ? contextTokens
        : 32768;

    if (ctx <= 10_000) {
        return { contextTokens: ctx, maxTools: 8, descChars: 90, paramDescChars: 60 };
    }

    if (ctx <= 40_000) {
        return { contextTokens: ctx, maxTools: 16, descChars: 160, paramDescChars: 80 };
    }

    if (ctx <= 160_000) {
        return { contextTokens: ctx, maxTools: 24, descChars: 220, paramDescChars: 110 };
    }

    return { contextTokens: ctx, maxTools: 32, descChars: 240, paramDescChars: 120 };

}

const HARD_CAP = 48;

/**
 * Potong daftar kandidat berperingkat menjadi final selection.
 * @param {Array} ranked      [{record, score, reasons}] urut terbaik dulu
 * @param {object} input
 *   usedTokens     perkiraan token yang sudah dipakai prompt
 *   reservedCount  N entri TERAKHIR ranked yang WAJIB ikut (backbone)
 *   overrides      {maxTools} dari pemanggil
 * @returns {{selected, budget}}
 */
function apply(ranked = [], { usedTokens = 0, reservedCount = 0, overrides = {} } = {}) {

    const profile = profileFor(overrides.contextTokens);

    const maxTools = Math.min(
        HARD_CAP,
        Number.isFinite(overrides.maxTools) && overrides.maxTools > 0
            ? overrides.maxTools
            : profile.maxTools
    );

    const remaining =
        profile.contextTokens - Math.max(0, usedTokens) - RESERVE_TOKENS;

    let schemaBudget = Math.floor(remaining * SCHEMA_SHARE);

    schemaBudget = Math.max(MIN_SCHEMA_BUDGET, Math.min(MAX_SCHEMA_BUDGET, schemaBudget));

    // Entri cadangan (tulang punggung, diletakkan di ekor ranked)
    // melewati anggaran: ia janji sistem, bukan hasil pencarian.
    const splitAt = Math.max(0, ranked.length - Math.min(reservedCount, ranked.length));

    const deferred = ranked.slice(splitAt);

    const pool = ranked.slice(0, splitAt);

    const selected = [];

    let spent = 0;

    // H3: segmen reserved adalah BAGIAN anggaran. PEMANGGIL wajib
    // memastikan reservedCount <= maxTools (Pipeline memotong
    // STABLE_ORDER sesuai kebijakan); total tak pernah melebihi
    // maxTools — tidak ada jalur yang melewatinya.
    const effectiveMax = maxTools;

    const take = (candidate, forced = false) => {

        if (selected.length >= effectiveMax) return false;

        if (selected.some(s => s.record.name === candidate.record.name)) return true;

        const view = SchemaMinimizer.toView(candidate.record.raw ?? candidate, profile);

        const cost = SchemaMinimizer.estimateTokens(view);

        // Tool pertama selalu lewat walau melebihi anggaran nominal:
        // kosong sama sekali lebih buruk daripada sedikit kelebihan.
        if (!forced && selected.length > 0 && spent + cost > schemaBudget) return false;

        selected.push({ ...candidate, view });
        spent += cost;

        return true;

    };

    // RESERVED DULU (kanonik, terjamin), dinamis memakai sisa slot.
    for (const c of deferred) take(c, true);

    for (const c of pool) take(c);

    return {
        selected,
        budget: {
            contextTokens: profile.contextTokens,
            maxTools,
            schemaBudgetTokens: schemaBudget,
            schemaTokensUsed: spent,
            descChars: profile.descChars,
            paramDescChars: profile.paramDescChars
        }
    };

}

module.exports = { apply, profileFor, HARD_CAP };

