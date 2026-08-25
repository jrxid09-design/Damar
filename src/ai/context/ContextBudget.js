const Budget = require("../tools/Budget");

/**
 * CONTEXT BUDGET — anggaran context model-aware.
 *
 * Bukan angka arbitrer: diturunkan dari jendela konteks model aktif
 * (sumber sama dengan ToolBudget — tanpa hardcode provider/model):
 *
 *   totalWindow
 *     - reservedOutput        (ruang jawaban)
 *     - toolAllowance         (estimasi schema tool Tool Intelligence)
 *     - safetyMargin
 *     = dynamicContextBudget  → dialokasikan per kategori
 *
 * Context besar BUKAN alasan mengirim semua: alokasi per kategori
 * punya langit-langit sendiri, dan sisa tak dipakai TIDAK dialihkan
 * ke kategori noise.
 */

const RESERVED_OUTPUT = 1024;
const SAFETY_MARGIN = 512;

/** Estimasi token rata-rata satu schema tool termampatkan. */
const AVG_TOOL_SCHEMA_TOKENS = 48;

/** Langit-langit per kategori (fraksi dari dynamic budget). */
const CATEGORY_CAPS = {
    relevant_history: 0.35,
    memory: 0.30,
    mind: 0.15,
    worker: 0.60,
    refs: 0.50,
    tool_observation: 0.40,
    other: 0.20
};

function profileFor(contextTokens) {
    return Budget.profileFor(contextTokens);
}

/**
 * @param {object} input
 *   contextTokens  window model aktif (ops; default konservatif)
 *   stableTokens   perkiraan token bagian stabil (system+device+directive+channel)
 *   maxTools       jumlah tool yang diperkirakan terlampir
 * @returns {{dynamicBudget, allocations}}
 */
function compute({ contextTokens = null, stableTokens = 0, maxTools = 16 } = {}) {

    // H6 Round-3 PRESEDENS: window yang diketahui pemanggil MENANG;
    // env fallback TIDAK BOLEH memperbesarnya — hanya mengecekkan.
    const envN = Number(process.env.AETHER_MODEL_CONTEXT_TOKENS);
    const envWindow = Number.isFinite(envN) && envN > 0 ? envN : null;

    let effective = contextTokens;

    if (effective > 0) {
        if (envWindow) effective = Math.min(effective, envWindow);
    }
    else {
        effective = envWindow ?? undefined;
    }

    const profile = profileFor(effective);

    const window = profile.contextTokens;

    const toolAllowance =
        Math.min(maxTools, profile.maxTools) * AVG_TOOL_SCHEMA_TOKENS;

    const dynamicBudget = Math.max(
        512,
        window - RESERVED_OUTPUT - SAFETY_MARGIN - Math.max(0, stableTokens) - toolAllowance
    );

    // Alokasi nominal per kategori: fraksi × budget, dibatasi atas.
    const allocations = {};

    for (const [kind, fraction] of Object.entries(CATEGORY_CAPS)) {
        allocations[kind] = Math.floor(dynamicBudget * fraction);
    }

    return { dynamicBudget, allocations, profile };

}

/** Kategori mana yang menang saat butuh ruang ekstra — urutan korban. */
function stealOrder(selectedKindCounts) {

    // Yang paling mungkin noise dikorbankan lebih dulu daripada
    // memori/history yang relevan.
    return ["mind", "refs", "memory", "relevant_history", "worker"];

}

module.exports = { compute, RESERVED_OUTPUT, SAFETY_MARGIN, CATEGORY_CAPS, stealOrder };

