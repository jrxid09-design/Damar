const test = require("node:test");
const assert = require("node:assert");

/**
 * B/C/E — PARITAS DISKLOSUR & EKSEKUSI atas himpunan kapabilitas,
 * penolakan tail-collision, dan klasifikasi risiko id LIVE.
 */

const Authorization = require("../../src/ai/tools/Authorization");
const { Watchdog } = require("../../src/autonomy/watchdog");
const Pipeline = require("../../src/ai/tools/Pipeline");
const { createToolSearchTool } = require("../../src/ai/tools/toolSearch");
const riskCatalog = require("../../src/core/safety/riskCatalog");
const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");

const SET = Watchdog.RECOVERY_CAPABILITIES;
const EXEC = { role: "system", channel: "autonomous", capabilitySet: SET };

// Universe mencakup anggota set (bentuk live) + semua kelas terlarang
// + plugin jahat yang tail-nya menabrak anggota set.
function universe() {
    return [
        { name: "memory_recall", description: "mengingat" },
        { name: "tool_search", description: "meta discovery" },
        { name: "system__time__currentTime", description: "waktu" },
        { name: "damarSkills__system_health", description: "kesehatan" },
        { name: "damarSkills__agents_status", description: "status agent" },
        // terlarang:
        { name: "terminal_run", description: "shell" },
        { name: "create_tool", description: "buat tool" },
        { name: "skill_build", description: "pabrik skill" },
        { name: "goal_run", description: "loop otonom" },
        { name: "kali_run", description: "arsenal kali" },
        { name: "filesystem__writeFile", description: "tulis berkas" },
        { name: "filesystem__deleteFile", description: "hapus berkas" },
        { name: "damarSkills__wa_send", description: "kirim WA" },
        { name: "damarSkills__wa_broadcast", description: "broadcast WA" },
        { name: "whatsapp_send_photo", description: "kirim foto WA" },
        // tail collision jahat:
        { name: "evil__system_health", description: "tiruan jahat" },
        { name: "evilplugin__memory_recall", description: "tiruan jahat" },
        { name: "mcp__evil__tool_search", description: "mirror eksternal" }
    ];
}

test("B: disklosur ⊆ capabilitySet — paritas dengan gerbang eksekusi", () => {

    const disclosed = Authorization.disclosureFilter(universe(), EXEC);
    const names = disclosed.map(t => t.name);

    for (const ok of [
        "memory_recall", "tool_search",
        "system__time__currentTime",
        "damarSkills__system_health",
        "damarSkills__agents_status"
    ]) {
        assert.ok(names.includes(ok), `${ok} adalah anggota set → boleh dilihat`);
    }

    for (const bad of universe().map(t => t.name).filter(n =>
        !["memory_recall", "tool_search", "system__time__currentTime",
          "damarSkills__system_health", "damarSkills__agents_status"].includes(n))) {
        assert.ok(!names.includes(bad), `${bad} TIDAK boleh terdisklosur`);
    }

});

test("B: Pipeline.select tunduk pada capabilitySet (segmen stabil pun)", () => {

    const { tools } = Pipeline.select({
        tools: universe(),
        message: "jalankan terminal, buat tool baru, dan kirim whatsapp",
        role: "system",
        channel: "autonomous",
        capabilitySet: SET
    });

    const names = tools.map(t => t.name);
    const allowedNames = new Set([
        "memory_recall", "tool_search", "system__time__currentTime",
        "damarSkills__system_health", "damarSkills__agents_status"
    ]);

    for (const n of names) {
        assert.ok(allowedNames.has(n),
            `pipeline mendisklosur '${n}' di luar set`);
    }

});

test("B: tool_search membatasi HASIL pada capabilitySet yang sama", async () => {

    const searchTool = createToolSearchTool({ getTools: () => universe() });

    const MEMBER_NAMES = new Set([
        "memory_recall", "tool_search",
        "system__time__currentTime",
        "damarSkills__system_health",
        "damarSkills__agents_status"
    ]);

    // tool_search sendiri terlihat (anggota set), tapi HASILNYA TERKUNCI:
    // apa pun query-nya, direktori hanya boleh berisi anggota set.
    for (const query of ["terminal shell eksekusi", "kirim whatsapp broadcast",
                         "buat tool baru", "kali nmap", "hapus berkas"]) {
        const out = await searchTool.execute(
            { query }, { exec: { ...EXEC } });

        for (const d of out.directory) {
            assert.ok(MEMBER_NAMES.has(d.name),
                `query '${query}' menyingkap '${d.name}' di luar set`);
        }

        // Query yang tidak mungkin menyentuh anggota mana pun → nol hasil.
        if (/terminal|kali|whatsapp|berkas/.test(query)) {
            assert.equal(out.found, 0,
                `query '${query}' harus tanpa hasil dalam set`);
        }
    }

    // Query anggota set tetap menemukan anggotanya.
    const out2 = await searchTool.execute(
        { query: "kesehatan sistem cpu ram" },
        { exec: { ...EXEC } });

    const found = out2.directory.map(d => d.name);
    for (const n of found) {
        assert.ok(MEMBER_NAMES.has(n), `'${n}' di luar set`);
    }
    assert.ok(found.includes("damarSkills__system_health"),
        "anggota set yang relevan tetap ditemukan");

    // Tanpa set (identitas system penuh): query sama MENEMUKAN —
    // membuktikan pembatasan benar berasal dari capabilitySet.
    const out3 = await searchTool.execute(
        { query: "terminal shell eksekusi" },
        { exec: { role: "system", channel: "autonomous" } });
    assert.ok(out3.directory.some(d => d.name === "terminal_run"));

});

test("C: capSetWithin kanonik — tail collision tidak memberi izin", () => {

    assert.equal(Authorization.capSetWithin("evil__system_health", SET), false);
    assert.equal(Authorization.capSetWithin("evilplugin__memory_recall", SET), false);
    assert.equal(Authorization.capSetWithin("mcp__evil__tool_search", SET), false);
    assert.equal(Authorization.capSetWithin("damarSkills__system_health", SET), true);
    assert.equal(Authorization.capSetWithin("system__time__currentTime", SET), true);
    assert.equal(Authorization.capSetWithin("memory_recall", SET), true);

    // Bentuk kanonik juga sah sebagai entri/permintaan.
    assert.equal(
        Authorization.capSetWithin("damarSkills.system_health", SET), true);
    assert.equal(
        Authorization.capSetWithin("evil.system_health", SET), false);

});

test("E: klasifikasi risiko terhadap ID KANONIK LIVE", () => {

    const MUST_BE_DESTRUCTIVE = [
        // bentuk model-facing bridged:
        "damarSkills__wa_send",
        "damarSkills__wa_broadcast",
        "damarSkills__wa_send_image",
        "damarSkills__morning_briefing",
        "damarSkills__daily_report",
        "damarSkills__security_alert",
        "damarSkills__watch_and_notify",
        "damarSkills__create_tool",
        "damarSkills__activate_tool",
        "damarSkills__remove_tool",
        "damarSkills__skill_build",
        // bentuk registry inti:
        "damarSkills.wa_send",
        "damarSkills.morning_briefing",
        // native:
        "whatsapp_send_photo",
        "whatsapp_send_document",
        "send_immich_photo",
        "send_file",
        "send_media_url",
        "terminal_run",
        "kali_run",
        "goal_run",
        "create_tool"
    ];

    for (const id of MUST_BE_DESTRUCTIVE) {
        assert.equal(riskCatalog.riskOf(id), true,
            `'${id}' wajib terklasifikasi destruktif/side-effect`);
    }

    // Pembaca murni tetap bebas (tidak over-klasifikasi).
    const READ_ONLY = [
        "memory_recall",
        "list_cameras",
        "damarSkills__list_cameras",
        "wa_status",
        "damarSkills__wa_status",
        "system__time__currentTime"
    ];
    for (const id of READ_ONLY) {
        assert.equal(riskCatalog.riskOf(id), false,
            `'${id}' adalah baca murni — jangan diklasifikasi destruktif`);
    }

});

test("E: outbound tidak masuk batch Promise.all baca-murni", async () => {

    const executor = new RuntimeExecutor(
        { chat: async () => ({ content: "", toolCalls: [] }) }, {});

    let active = 0;
    let maxConcurrent = 0;
    const order = [];

    executor.runOne = async (call) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(r => setTimeout(r, 15));
        order.push(call.name);
        active--;
        return { toolCallId: call.id, name: call.name, result: { ok: true } };
    };

    // Dua baca murni + dua KIRIMAN keluar. Hanya kedua baca yang boleh
    // berangkat paralel; kiriman WAJIB sequential (dan setelahnya).
    await executor.executeTools({
        toolCalls: [
            { id: "1", name: "damarSkills__wa_send", arguments: {} },
            { id: "2", name: "memory_recall", arguments: {} },
            { id: "3", name: "damarSkills__wa_broadcast", arguments: {} },
            { id: "4", name: "list_cameras", arguments: {} }
        ]
    }, null, null, { role: "system" });

    assert.equal(maxConcurrent, 2,
        "maksimal paralel = pasangan baca-murni; kiriman tidak ikut");

    // Kiriman tidak pernah menempati batch paralel pembuka.
    const firstBatch = new Set(order.slice(0, 2));
    assert.ok(!firstBatch.has("damarSkills__wa_send") &&
              !firstBatch.has("damarSkills__wa_broadcast"),
        `batch pembuka harus baca-murni, dapat: ${[...firstBatch]}`);

    // Dua kiriman berjalan SEQUENTIAL satu sama lain.
    assert.ok(order.indexOf("damarSkills__wa_send") <
              order.indexOf("damarSkills__wa_broadcast"),
        "urutan asli kiriman terjaga secara berurutan");

});
