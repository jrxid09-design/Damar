/**
 * CONTEXT ITEM — satuan context ternormalisasi.
 *
 * Context Intelligence tidak memperlakukan context sebagai tumpukan
 * string. Setiap potongan informasi yang berpotensi masuk prompt
 * dibungkus ContextItem supaya bisa DIPERANKING, DIANGGARKAN,
 * DIDUPLIKASI-HAPUS, dan DIKOMPRESI secara deterministik — dengan
 * provenance yang jelas.
 *
 * Model sengaja kecil: field di bawah adalah minimum yang dibutuhkan
 * ranking/budget/telemetry. Jenis (kind) hanya yang benar-benar ada
 * sumbernya di repo hari ini — jangan over-model.
 */

const KIND = {
    SYSTEM: "system",               // persona + aturan inti (stabil)
    DEVICE: "device",               // baris perangkat/OS (stabil)
    DIRECTIVE: "directive",         // doktrin kondisional per topik
    CHANNEL: "channel",             // metadata kanal aktif
    RECENT_HISTORY: "recent_history",
    RELEVANT_HISTORY: "relevant_history",
    MEMORY: "memory",
    MIND: "mind",                   // keadaan batin (dinamis tiap giliran)
    WORKER: "worker",               // instruksi peran worker AgentHub
    TOOL_OBSERVATION: "tool_observation",
    REFS: "refs"                    // hasil resolveContextRefs (port Pandawa)
};

/** Perkiraan token teks polos: panjang / 4 (cukup untuk anggaran). */
function estimateTextTokens(text) {
    return Math.ceil(String(text ?? "").length / 4);
}

let SEQ = 0;

/**
 * Buat ContextItem. `content` adalah TEKS final siap prompt;
 * referensi besar tetap teks — pemanggil yang memangkas sebelum
 * memanggil (sumber bertanggung jawab atas ukuran mentahnya).
 */
function create({
    source,
    kind,
    content,
    relevance = 0,
    priority = 0,
    stable = false,
    mandatory = false,
    compressible = true,
    provenance = null,
    sensitivity = null,
    freshness = null,
    fact = null,
    metadata = {}
}) {

    if (!source || !kind || content === undefined || content === null) {
        throw new Error("ContextItem butuh source, kind, dan content.");
    }

    const text = String(content);

    const freshnessState = freshness?.state ?? "unknown";
    if (!["known", "unknown", "stale"].includes(freshnessState)) {
        throw new Error(`ContextItem freshness state tidak valid: ${freshnessState}`);
    }

    const normalizedFreshness = Object.freeze({
        state: freshnessState,
        version: freshness?.version ?? null,
        observedAt: freshness?.observedAt ?? null,
        expiresAt: freshness?.expiresAt ?? null,
        invalidated: Boolean(freshness?.invalidated)
    });

    let normalizedFact = null;
    if (fact !== null && fact !== undefined) {
        if (!fact.key || !["known", "unknown", "conflicting"].includes(fact.state ?? "known")) {
            throw new Error("ContextItem fact membutuhkan key dan state yang valid.");
        }
        normalizedFact = Object.freeze({
            key: String(fact.key),
            value: fact.value ?? null,
            state: fact.state ?? "known",
            source: fact.source ?? provenance ?? source,
            observedAt: fact.observedAt ?? null
        });
    }

    return {
        id: `${kind}:${source}:${++SEQ}`,
        source,
        kind,
        content: text,
        relevance,
        priority,
        tokenEstimate: estimateTextTokens(text),
        createdAt: null,            // sengaja: determinisme > timestamp
        updatedAt: null,
        stable: Boolean(stable),
        mandatory: Boolean(mandatory),
        compressible: compressible !== false,
        provenance: provenance ?? source,
        sensitivity: sensitivity ?? null,
        metadata,
        freshness: normalizedFreshness,
        fact: normalizedFact
    };

}

function freshnessState(item, now = Date.now()) {
    const f = item?.freshness ?? {};
    if (f.invalidated || f.state === "stale") return "stale";
    if (f.expiresAt !== null && f.expiresAt !== undefined && now >= f.expiresAt) return "stale";
    return f.state ?? "unknown";
}

function invalidate(item, { version = null, observedAt = null } = {}) {
    return {
        ...item,
        freshness: Object.freeze({
            ...(item.freshness ?? {}),
            state: "stale",
            invalidated: true,
            version,
            observedAt
        })
    };
}

module.exports = { KIND, create, estimateTextTokens, freshnessState, invalidate };
