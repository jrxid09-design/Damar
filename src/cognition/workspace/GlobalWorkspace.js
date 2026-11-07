const { clamp01 } = require("../core/envelope");

/**
 * GLOBAL WORKSPACE (§26–§28/§105) — kompetisi atensi deterministik.
 * Urutan event sama → isi workspace sama (replay-stable).
 *
 * Anti-starvation dicapai lewat agingBonus di score(): item yang lama
 * tidak menang naik salience-nya seiring umur hingga terpilih.
 */

function emptyWorkspace() {
    return {
        items: [],            // kapasitas terbatas, terurut salience desc
        habituation: {},      // key → 0..1
        lastSelectedAt: {}    // key → ms
    };
}

/** Skor salience §27 — bobot dari config (versioned), tanpa randomness. */
function score(item, weights, context) {

    const w = weights;
    const ageHours = Math.max(0,
        (context.nowMs - (item.createdAtMs ?? context.nowMs)) / 3_600_000);

    const aging = Math.min(
        context.agingBonusMax,
        ageHours * context.agingBonusPerHour);

    const repetition =
        clamp01(context.habituation ?? 0) * context.repetitionPenalty;

    return clamp01(
        w.novelty * clamp01(item.novelty ?? 0.3) +
        w.urgency * clamp01(item.urgency ?? 0.3) +
        w.goalRelevance * clamp01(item.goalRelevance ?? 0.3) +
        w.predictionError * clamp01(item.predictionError ?? 0) +
        w.affectMagnitude * clamp01(item.affectMagnitude ?? 0) +
        w.homeostaticRelevance * clamp01(item.homeostaticRelevance ?? 0) +
        w.confidence * clamp01(item.confidence ?? 0.5) +
        aging - repetition
    );

}

/** Tambah/kompetisi satu kandidat; kembalikan workspace baru. */
function admit(workspace, item, config, nowMs) {

    const next = structured(workspace);
    const key = String(item.key ?? "").slice(0, 160);
    if (!key) return next;

    const scored = {
        ...structuredCopyItem(item),
        key,
        createdAtMs: item.createdAtMs ?? nowMs
    };

    scored.salience = score(scored, config.salienceWeights, {
        nowMs,
        habituation: next.habituation[key] ?? 0,
        ...config.workspace
    });

    next.habituation[key] =
        Math.min(1, (next.habituation[key] ?? 0) + 0.34);

    // Buat entri TTL-kadaluarsa & dedupe by key.
    next.items = next.items
        .filter(it => it.key !== key)
        .filter(it => nowMs - (it.createdAtMs ?? nowMs) <= config.workspace.ttlMs);

    next.items.push(scored);
    next.items.sort(compareItems);          // deterministik + tie-break stabil

    if (next.items.length > config.workspace.capacity) {
        next.items.length = config.workspace.capacity;   // yang tenggelam = salience terendah
    }

    return next;
}

function compareItems(a, b) {
    if (b.salience !== a.salience) return b.salience - a.salience;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;   // tie-break stabil
}

/** Pembersih TTL + peluruhan habituation waktu-nyata. */
function sweep(workspace, config, nowMs) {

    const next = structured(workspace);

    next.items = next.items.filter(
        it => nowMs - (it.createdAtMs ?? nowMs) <= config.workspace.ttlMs);

    for (const [key, value] of Object.entries(next.habituation)) {
        const decayed = clamp01(value - config.workspace.habituationDecayPerHour);
        if (decayed <= 0) delete next.habituation[key];
        else next.habituation[key] = decayed;
    }

    return next;
}

function selectTop(workspace, nowMs) {
    if (!workspace.items.length) return null;
    const top = workspace.items[0];
    const next = structured(workspace);
    next.lastSelectedAt[top.key] = nowMs;
    return { item: top, workspace: next };
}

function structured(ws) {
    return {
        items: (ws.items ?? []).map(it => ({ ...it })),
        habituation: { ...(ws.habituation ?? {}) },
        lastSelectedAt: { ...(ws.lastSelectedAt ?? {}) }
    };
}

function structuredCopyItem(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
        out[k] = v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
}

module.exports = { emptyWorkspace, admit, sweep, selectTop, score };
