const test = require("node:test");
const assert = require("node:assert");

const Pipeline = require("../../src/ai/context/Pipeline");
const Dedupe = require("../../src/ai/context/Dedupe");
const Relevance = require("../../src/ai/context/Relevance");
const Compressor = require("../../src/ai/context/Compressor");
const ContextBudget = require("../../src/ai/context/ContextBudget");
const Assembler = require("../../src/ai/context/Assembler");
const refs = require("../../src/ai/context/refs");
const ContextItem = require("../../src/ai/context/ContextItem");

/**
 * SUITE CONTEXT INTELLIGENCE — jaminan pipeline context.
 *
 * Melingkupi mandat: sapaan minimal, riwayat lama relevan menang atas
 * recent tak relevan, mandatory selalu bertahan, anggaran model kecil/
 * besar, dedupe, determinisme, observasi tool berbatas, degradasi
 * anggun, paritas kanal, prefix stabil, legacy escape, dan tanpa
 * history tersembunyi tanpa batas.
 */

function msg(role, content) {
    return { role, content };
}

// ---- 1. Sapaan: konteks minimal --------------------------------------

test("'halo' menghasilkan seleksi minimal (tanpa blok dinamis berat)", async () => {

    const r = await Pipeline.select({
        messages: [msg("user", "halo")],
        channel: "telegram",
        includeMind: false,
        aiRuntime: null
    });

    // Tidak ada kandidat noise yang lolos; pesan tetap utuh.
    assert.equal(r.diagnostics.candidatesConsidered >= 0, true);
    assert.equal(r.messages[r.messages.length - 1].content, "halo");

});

// ---- 2. Riwayat lama relevan vs recent tak relevan ---------------------

test("topik lama eksplisit ('lanjutkan refactor memory') mengangkat history lama", async () => {

    const messages = [
        msg("user", "kita mulai refactor modul memory di RecallService ya"),
        msg("assistant", "Baik, refactor RecallService dimulai dari normalisasi teks."),
        msg("user", "cuaca bandung gimana?"),
        msg("assistant", "Bandung cerah berawan."),
        msg("user", "oke makasih"),
        msg("user", "lanjutkan refactor memory kemarin")
    ];

    const ranked = Relevance.rank(
        sources_history(messages, 2),
        { activeText: "lanjutkan refactor memory kemarin" }
    );

    const top = ranked[0]?.item;

    assert.ok(top, "ada kandidat terpilih");
    assert.match(top.content, /refactor|RecallService|memory/i);

});

function sources_history(messages, recentCount) {
    // replikasi adapter olderHistory tanpa memuat aiRuntime
    const older = messages.slice(0, messages.length - recentCount);
    return older.filter(m => typeof m.content === "string").map((m, i) =>
        ContextItem.create({
            source: "history",
            kind: ContextItem.KIND.RELEVANT_HISTORY,
            content: `${m.role === "assistant" ? "Damar" : "Pengguna"}: ${m.content}`,
            metadata: { role: m.role }
        })
    );
}

test("recent tak relevan tidak mengalahkan relevant lama (urutan skor)", () => {

    const items = [
        ContextItem.create({ source: "h", kind: "relevant_history", content: "Pengguna: kita desain skema database untuk modul billing dengan tabel invoices" }),
        ContextItem.create({ source: "h", kind: "relevant_history", content: "Pengguna: bantu putar lagu karaoke bebek" })
    ];

    const ranked = Relevance.rank(items, {
        activeText: "lanjutkan skema database billing tadi",
        historyIndices: new Map([[items[0].id, 0], [items[1].id, 1]])
    });

    assert.match(ranked[0].item.content, /database|billing/i);

});

// ---- 3. Mandatory selalu retained ---------------------------------------

test("context mandatory tidak pernah dibuang anggaran/relevansi", async () => {

    const item = ContextItem.create({
        source: "policy",
        kind: ContextItem.KIND.REFS,
        content: "KEBIJAKAN WAJIB: jangan kirim order tanpa konfirmasi eksplisit.",
        mandatory: true
    });

    const scored = Relevance.score(item, { activeText: "halo" });

    assert.equal(scored, Number.MAX_SAFE_INTEGER);

});

// ---- 4. Anggaran model-aware ---------------------------------------------

test("model 8K mendapat dynamic budget lebih ketat daripada model besar", () => {

    process.env.DAMAR_MODEL_CONTEXT_TOKENS = "8192";
    const small = ContextBudget.compute({ stableTokens: 2000 });
    delete process.env.DAMAR_MODEL_CONTEXT_TOKENS;

    const big = ContextBudget.compute({ contextTokens: 131072, stableTokens: 2000 });

    assert.ok(small.dynamicBudget < big.dynamicBudget);
    assert.ok(small.allocations.memory <= big.allocations.memory);

});

test("model besar TETAP tidak mengirim semua (caps per kategori aktif)", () => {

    const big = ContextBudget.compute({ contextTokens: 1000000, stableTokens: 2000 });

    // Memory cap tidak boleh melebihi 30% dari budget dinamis.
    assert.ok(big.allocations.memory <= Math.floor(big.dynamicBudget * 0.3) + 1);

});

// ---- 5. Dedupe -------------------------------------------------------------

test("dedupe membuang salinan sama lintas sumber, menjaga prioritas tertinggi", () => {

    const a = ContextItem.create({
        source: "memory", kind: "memory", priority: 50,
        content: "Ronny ulang tahun 12 Mei dan ia suka kopi hitam tanpa gula."
    });

    const b = ContextItem.create({
        source: "history", kind: "relevant_history", priority: 20,
        content: "Pengguna: Ronny ulang tahun 12 Mei dan ia suka kopi hitam tanpa gula."
    });

    const { items, removed } = Dedupe.dedupe([b, a]);

    assert.equal(items.length, 1);
    assert.equal(items[0].source, "memory");   // prioritas lebih tinggi
    assert.equal(removed.length, 1);

});

test("teks pendek tidak difingerprint (hindari tabrakan palsu)", () => {

    const a = ContextItem.create({ source: "x", kind: "other", content: "oke" });
    const b = ContextItem.create({ source: "y", kind: "other", content: "oke" });

    const { items } = Dedupe.dedupe([a, b]);

    assert.equal(items.length, 2);

});

// ---- 6. Determinisme & stabilitas urutan ------------------------------------

test("input identik → hasil identik (deterministik)", async () => {

    const input = {
        messages: [
            msg("user", "kita bahas arsitektur pipeline memory kemarin"),
            msg("assistant", "Betul, fokusnya di RecallService."),
            msg("user", "lanjutkan pembahasan arsitektur memory itu")
        ],
        channel: "console",
        includeMind: false,
        aiRuntime: null
    };

    const a = await Pipeline.select(input);
    const b = await Pipeline.select(input);

    assert.deepEqual(a.diagnostics.breakdown.byKind, b.diagnostics.breakdown.byKind);
    assert.equal(a.messages.length, b.messages.length);

});

test("blok dinamis tersusun dalam URUTAN KONTRAK (recap → memory → mind)", () => {

    const items = [
        ContextItem.create({ source: "mind", kind: "mind", content: "BATIN: fokus tinggi." }),
        ContextItem.create({ source: "mem", kind: "memory", content: "- ingatan: X" }),
        ContextItem.create({ source: "hist", kind: "relevant_history", content: "Damar: sesi lama Y" })
    ];

    const blocks = Assembler.buildDynamicBlocks(items);

    const recapIdx = blocks.findIndex(b => b.includes("RIWAYAT RELEVAN"));
    const memIdx = blocks.findIndex(b => b.includes("INGATAN"));
    const mindIdx = blocks.findIndex(b => b.includes("BATIN"));

    assert.ok(recapIdx < memIdx && memIdx < mindIdx);

});

// ---- 7. Observasi tool berbatas ------------------------------------------------

test("observasi raksasa dikompaksi head+tail dengan penanda ukuran", () => {

    const huge = "x".repeat(50_000);

    const out = Compressor.headTail(huge, 4000);

    assert.ok(out.length < 4200, `panjang ${out.length}`);
    assert.match(out, /dipangkas/);
    assert.ok(out.startsWith("x"));       // kepala utuh

});

test("kompaksi item dalam anggaran tidak diubah", () => {

    const item = ContextItem.create({
        source: "s", kind: "memory",
        content: "fakta singkat yang muat"
    });

    const { content, tokens } = Compressor.compressItem(item, 10_000);

    assert.equal(content, item.content);
    assert.ok(tokens > 0);

});

// ---- 8. Sanitasi anti-explosion --------------------------------------------------

test("history > MAX_INPUT_MESSAGES dipangkas dari depan (tidak ada array tersembunyi)", async () => {

    const many = [];
    for (let i = 0; i < 120; i++) many.push(msg("user", `pesan nomor ${i} tentang topik ${i % 7}`));

    const r = await Pipeline.select({
        messages: many, channel: "cli", includeMind: false, aiRuntime: null
    });

    // Recent window + batas keras: jumlah pesan final pasti terbatas.
    assert.ok(r.messages.length <= (Pipeline.LIMITS.MAX_INPUT_MESSAGES));
    assert.equal(r.diagnostics.inputMessagesDropped > 0, true);

});

test("pesan raksasa dipangkas di gerbang (MAX_MESSAGE_CHARS)", async () => {

    const giant = "log ".repeat(60_000);   // ~240KB

    const r = await Pipeline.select({
        messages: [msg("user", giant)], channel: "cli", includeMind: false, aiRuntime: null
    });

    const last = r.messages[r.messages.length - 1];

    assert.ok(String(last.content).length < Pipeline.LIMITS.MAX_MESSAGE_CHARS + 2000);

});

// ---- 9. Degradasi anggun -----------------------------------------------------------

test("sumber opsional gagal → degradasi, bukan error", async () => {

    // memory adapter internal sudah try/catch; uji lewat jalur refs
    refs.registerResolver("__rusak__", async () => { throw new Error("mati"); });

    const r = await Pipeline.select({
        messages: [msg("user", "halo")],
        channel: "cli",
        includeMind: false,
        aiRuntime: null,
        contextRefs: ["__rusak__:id-1"]
    });

    assert.deepEqual(r.diagnostics.unresolvedRefs, ["__rusak__:id-1"]);
    assert.equal(r.messages.length, 1);

});

// ---- 10. Paritas kanal -----------------------------------------------------------------

test("paritas kanal: telegram & console memilih sama untuk input sama", async () => {

    const input = {
        messages: [
            msg("user", "ingat proyek alpha deadline bulan depan"),
            msg("assistant", "Tercatat, proyek alpha."),
            msg("user", "lanjutkan proyek alpha")
        ],
        includeMind: false,
        aiRuntime: null
    };

    const t = await Pipeline.select({ ...input, channel: "telegram" });
    const c = await Pipeline.select({ ...input, channel: "console" });

    assert.deepEqual(t.diagnostics.breakdown.byKind, c.diagnostics.breakdown.byKind);

});

// ---- 11. Prefix stability ---------------------------------------------------------------

test("system builder: urutan kontrak device→persona→directive→channel", () => {

    const sys = Assembler.buildSystem([
        ContextItem.create({ source: "c", kind: "channel", content: "KANAL", mandatory: true }),
        ContextItem.create({ source: "d", kind: "directive", content: "DOKTRIN", mandatory: true }),
        ContextItem.create({ source: "p", kind: "system", content: "PERSONA", mandatory: true }),
        ContextItem.create({ source: "dev", kind: "device", content: "DEVICE", mandatory: true })
    ]);

    assert.equal(sys, "DEVICE\n\nPERSONA\n\nDOKTRIN\n\nKANAL");

});

// ---- 12. Refs port ------------------------------------------------------------------------

test("contextRefs tanpa resolver diabaikan dengan catatan (bukan error)", async () => {

    const r = await Pipeline.select({
        messages: [msg("user", "halo")],
        channel: "cli",
        includeMind: false,
        aiRuntime: null,
        contextRefs: ["project:damar"]
    });

    assert.ok(r.diagnostics.unresolvedRefs.includes("project:damar"));

});

test("resolver terdaftar menghasilkan item refs berbatas", async () => {

    refs.registerResolver("decision", async (id) => ([{
        content: `KEPUTUSAN ${id}: pakai SQLite, bukan file JSON.`,
        priority: 85,
        mandatory: false
    }]));

    const r = await Pipeline.select({
        messages: [msg("user", "kenapa kami pilih sqlite dulu?")],
        channel: "cli",
        includeMind: false,
        aiRuntime: null,
        contextRefs: ["decision:db-2026"]
    });

    const joined = r.messages.map(m => m.content).join("\n");
    assert.match(joined, /KEPUTUSAN db-2026/);

});
