const CapabilityIndex = require("./CapabilityIndex");
const Retriever = require("./Retriever");
const Ranker = require("./Ranker");
const Budget = require("./Budget");
const SchemaMinimizer = require("./SchemaMinimizer");
const telemetry = require("../../services/telemetryService");

/**
 * TOOL INTELLIGENCE PIPELINE — satu jalur seleksi untuk semua kanal.
 *
 *   registry → index → retrieval (deterministik) → eligibility (peran,
 *   kanal) → ranking (stabil) → budget (context-aware) → tampilan
 *   schema minimal untuk LLM
 *
 * Semua yang memilih tool — Console, Telegram, WhatsApp, Voice,
 * worker AgentHub — MEWAJIB lewat sini. Tidak ada lagi daftar statis
 * per kanal; kanal hanya menyumbang konteks (channel, role, riwayat).
 *
 * Diagnostik seleksi dipancarkan ke telemetri (tool:selection) dan
 * tersedia via lastDiagnostics() untuk Console — tanpa reasoning
 * model, hanya metadata teknis.
 */

/** Tulang punggung: ikut SETIAP kali ada tool terpilih, di urutan depan. */
const BACKBONE_TAILS = [
    "memory_recall",
    "memory_remember",
    "currentTime",
    "readFile",
    "listDirectory"
];

function activeWindow(contextTokens) {
    return contextTokens
        ?? (Number(process.env.DAMAR_MODEL_CONTEXT_TOKENS) || undefined);
}

function envInt(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Seleksi untuk satu giliran.
 *
 * @param {object} input
 *   tools          seluruh AITool terdaftar (registry.all())
 *   message        pesan pengguna terakhir
 *   historyTexts   0-2 pesan pengguna sebelumnya (konteks sesi)
 *   channel        "console"|"telegram"|"whatsapp"|"voice"|"cli"|...
 *   role           "superadmin"|"admin"|"user"|null
 *   usedTokens     perkiraan token prompt yang sudah terpakai
 *   boost          nama/ruas tool yang diuntungkan (profil worker)
 *   maxTools       override anggaran (opsional)
 * @returns {{tools, diagnostics}} tools = tampilan model-facing
 */
function select({
    tools = [],
    message = "",
    historyTexts = [],
    channel = null,
    role = null,
    capabilitySet = null,
    usedTokens = 0,
    boost = [],
    maxTools = null,
    contextTokens = null
} = {}) {

    const started = Date.now();

    const records = CapabilityIndex.build(tools);

    // 1. Penemuan deterministik.
    let candidates = Retriever.retrieve(records, { message, historyTexts, boost });

    const candidateCount = candidates.length;

    // 2. Pagar kelayakan: peran (roleService) lalu metadata kanal.
    // Ini PAGAR, bukan preferensi — yang ditolak tidak masuk walau
    // skornya tertinggi. roleService dinilai per tool sehingga
    // seleksi tidak perlu menyentuh daftar penuh.
    // INVARIANT B + J: SATU gerbang disklosur (Authorization) untuk
    // pipeline, tool_search, dan deferred disclosure. Fail-closed:
    // komponen kebijakan mati → privileged tidak lolos sama sekali.
    const Authorization = require("./Authorization");

    candidates = Authorization.disclosureFilter(
        candidates.map(c => c.record),
        { role, channel, capabilitySet }
    ).map(rec =>
        // kembalikan bentuk kandidat berperingkat
        candidates.find(c => c.record.name === rec.name)
    ).filter(Boolean);

    // Non-aksi masa lalu: syukur/rujukan lampau tanpa imperatif.
    const PNA_WORD = "(?:^|[^a-z0-9])(?:%s)(?=$|[^a-z0-9])";
    const pastNonAction =
        new RegExp(PNA_WORD.replace("%s", "makasih|terima kasih|thanks|thank you"), "i").test(message) ||
        (new RegExp(PNA_WORD.replace("%s", "tadi|kemarin|barusan|sudah|telah"), "i").test(message) &&
         !new RegExp(PNA_WORD.replace("%s", "tolong|coba|sekarang|dong|ya"), "i").test(message));

    // 3. Pemeringkatan stabil.
    candidates = Ranker.applyBoosts(candidates, { channel, pastNonAction });

    // NON-AKSI LAMPAU (gerbang, bukan skor): tanpa sinyal imperatif,
    // kapabilitas berefek KELUAR dari kandidat — "makasih sudah
    // matiin lampu tadi" tidak boleh menawarkan saklar.
    if (pastNonAction) {
        candidates = candidates.filter(c => c.record.sideEffects !== true);
    }

    // SEGMEN STABIL (Phase 14 — diukur, bukan dikira): pipeline dinamis
    // murni mematahkan prefix cache lokal (avg common-prefix 3.1% vs
    // legacy 68.2%). Solusi hybrid: blok tulang-punggung berURUTAN
    // KANONIK selalu mendahului hasil dinamis — byte identik antar
    // giliran, sehingga prefix tetap panjang tanpa mengorbankan
    // relevansi di belakangnya.
    // Segmen stabil MINIMAL (7): tulang punggung + pintu discovery.
    // Otonomi/create/activate dikeluarkan agar anggaran dinamis cukup
    // luas untuk required-recall (benchmark V2.1); semuanya masih
    // dapat ditemukan model via tool_search.
    const STABLE_ORDER = [
        "memory_recall", "memory_remember", "currentTime",
        "readFile", "listDirectory", "writeFile",
        "tool_search"
    ];

    // 4a/5. RESERVED SEGMENT (H3 Round-2): tulang punggung + meta
    // discovery dalam urutan kanonik, lolos gerbang, dan DIHITUNG dalam
    // anggaran sebagai reserved — bukan injeksi pasca-anggaran.
    // Kebijakan hybrid (H3 final): segmen stabil MENYUSUT mengikuti
    // anggaran; slot dinamis selalu tersedia minimal 25% (>=2).
    const effProfile = Budget.profileFor(contextTokens
        ?? (Number(process.env.DAMAR_MODEL_CONTEXT_TOKENS) || undefined));
    const effMax = maxTools ?? envInt("DAMAR_TOOL_BUDGET", undefined)
        ?? effProfile.maxTools;
    const minDynamic = Math.max(2, Math.ceil(effMax * 0.25));
    const stableTake = Math.max(
        Math.min(4, effMax),
        Math.min(STABLE_ORDER.length, effMax - minDynamic));

    // tool_search adalah janji sistem (pintu discovery) — ia JANGAN
    // menjadi korban pemotongan anggaran.
    let stableList = STABLE_ORDER.slice(0, Math.max(1, stableTake - 1));

    if (!stableList.includes("tool_search")) {
        stableList = [...stableList, "tool_search"];   // tetap <= stableTake
    }

    const stableOrder = candidates.length ? stableList : [];

    const reservedSeg = [];
    const reservedTails = new Set();

    for (const tailName of stableOrder) {

        // Slot kanonik = identitas TERPERCAYA saja (H2): mirror
        // eksternal tak boleh menempati posisi stabil.
        const hit = candidates.find(c =>
            c.record.tail === tailName && !c.record.external);

        if (hit) {
            reservedSeg.push(hit);
            reservedTails.add(hit.record.name);
            continue;
        }

        const record = records.find(r =>
            r.tail === tailName && !r.external);

        if (record && Authorization.disclosureFilter(
                [record], { role, channel, capabilitySet }).length === 1) {
            reservedSeg.push({ record, score: 0, reasons: ["stable-segment"] });
        }
    }

    // Dinamis = kandidat di luar slot kanonik (hindari duplikasi ganda
    // yang dulu membuat item stabil bisa terbuang oleh anggaran).
    const dynamicCandidates = candidates.filter(c =>
        !reservedTails.has(c.record.name));

    const ranked = candidates.length
        ? [...dynamicCandidates, ...reservedSeg]
        : [];

    // Anggaran: reserved di ekor ranked → Budget.apply memaksa mereka;
    // maxTools efektif = max(permintaan, jumlah reserved) supaya segmen
    // stabil TIDAK melampaui anggaran yang dilaporkan (H3).
    const { selected, budget } = Budget.apply(ranked, {
        usedTokens,
        reservedCount: reservedSeg.length,
        overrides: {
            contextTokens: contextTokens
                ?? (Number(process.env.DAMAR_MODEL_CONTEXT_TOKENS) || undefined),
            maxTools: maxTools ?? envInt("DAMAR_TOOL_BUDGET", undefined)
        }
    });

    budget.maxTools = Math.max(budget.maxTools, reservedSeg.length);

    // Urutan final: segmen stabil (urutan kanonik) dulu — byte identik
    // antar giliran untuk prefix cache — lalu dinamis berperingkat.
    // Kemunculan PERTAMA di selected yang menang (reserved dibangun
    // sebelum dinamis) — bukan yang terakhir.
    const byTail = new Map();

    for (const it of selected) {
        if (!byTail.has(it.record.tail)) byTail.set(it.record.tail, it);
    }

    const finalStable = [];
    for (const tailName of stableOrder) {
        const hit = byTail.get(tailName);
        if (hit) finalStable.push(hit);
    }

    const seenStable = new Set(finalStable.map(i => i.record.name));
    const finalDynamic = selected.filter(it => !seenStable.has(it.record.name));

    let final = [...finalStable, ...finalDynamic];

    // ---- INVARIANT WINDOW (H6 Round-2): serialized final + tool
    // allowance tidak boleh melampaui window AKTIF setelah output +
    // margin. Diukur pada ESTIMASI SERIALIZED (bukan anggaran kategori).
    const winProfile = Budget.profileFor(activeWindow(contextTokens));

    const hardCapTokens = winProfile.contextTokens - 1024 - 512;

    const schemaEstimate = () =>
        SchemaMinimizer.estimateTokens(final.map(c => c.view));

    // usedTokens sudah mencakup system+history (dari pemanggil).
    let overflowTrimmed = 0;

    // B Round-3 — JAMINAN TERMINASI + RESPONS ANGGARAN AKTIF:
    //   - konteks sudah melampaui hard cap sebelum tool apa pun →
    //     TIDAK ada skema tool yang dilampirkan (omit), bukan diam;
    //   - tiap iterasi pemangkasan WAJIB mengurangi keadaan;
    //   - bila hanya kapabilitas stabil tersisa, segmen stabil di luar
    //     janji sistem (tool_search) JUGA dikorbankan — anggaran
    //     ditegakkan, bukan hanya dicatat.
    let overflowUnresolvable = false;

    const contextAlreadyOverBudget = usedTokens >= hardCapTokens;

    if (contextAlreadyOverBudget) {

        // Respons eksplisit: konteks sudah penuh — omit semua tool.
        final = [];
        overflowUnresolvable = true;

    }
    else {

        while (usedTokens + schemaEstimate() > hardCapTokens &&
               final.length > (selected.length ? 1 : 0)) {
            // Buang item dinamis TERAKHIR (stabil terakhir disisakan).
            let removed = false;

            for (let i = final.length - 1; i >= 0; i--) {
                if (!finalStable.includes(final[i])) { final.splice(i, 1); overflowTrimmed++; removed = true; break; }
            }

            if (!removed) {
                overflowUnresolvable = true;
                break;
            }
        }

        // Masih overflow setelah dinamis habis → korbankan kapabilitas
        // stabil non-esensial juga (tool_search tetap terakhir buang).
        if (overflowUnresolvable) {

            const essential = new Set(["tool_search"]);

            for (let i = final.length - 1; i >= 1 && usedTokens + schemaEstimate() > hardCapTokens; i--) {
                if (essential.has(final[i].record.tail)) continue;
                final.splice(i, 1);
                overflowTrimmed++;
            }

            overflowUnresolvable =
                usedTokens + schemaEstimate() > hardCapTokens;

        }

    }

    const diagnostics = {
        registeredTools: tools.length,
        candidateTools: candidateCount,
        eligibleTools: candidates.length,
        selectedTools: final.map(s => s.record.name),
        disclosedToolCount: final.length,
        toolScores: Object.fromEntries(
            candidates.slice(0, 20).map(c => [c.record.name, c.score])
        ),
        selectionReasons: Object.fromEntries(
            final.map(c => [c.record.name, c.reasons])
        ),
        schemaTokensBefore: SchemaMinimizer.estimateTokens(
            tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))
        ),
        schemaTokensAfter: schemaEstimate(),
        windowHardCap: hardCapTokens,
        overflowTrimmed,
        overflowUnresolvable,
        contextAlreadyOverBudget,
        budget,
        channel,
        role,
        selectionLatencyMs: Date.now() - started
    };

    telemetry.publish("tool:selection", diagnostics);

    return {
        tools: final.map(c => c.view),
        diagnostics
    };

}

module.exports = { select };

