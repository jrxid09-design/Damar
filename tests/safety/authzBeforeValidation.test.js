const test = require("node:test");
const assert = require("node:assert");

/**
 * CLOSURE L1 — OTORISASI SEBELUM VALIDASI ARGUMEN.
 *
 * Pemanggil di luar set/peran menerima PERMISSION_DENIED tanpa pernah
 * melihat schema/kebutuhan argumen tool yang dilarangnya; pemanggil
 * berizin tetap divalidasi normal (VALIDATION_ERROR untuk arg salah).
 */

const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const AIToolRegistry = require("../../src/ai/tools/AIToolRegistry");
const { AITool } = require("../../src/ai/tools");

function makeExecutor() {

    const registry = new AIToolRegistry();

    // Tool "rahasia" dengan schema yang TIDAK BOLEH bocor ke pemanggil
    // di luar otoritas: butuh parameter `vaultPath`.
    registry.register(new AITool({
        name: "vault_read",
        description: "Baca brankas.",
        parameters: {
            type: "object",
            properties: { vaultPath: { type: "string" } },
            required: ["vaultPath"]
        },
        execute: async () => ({ ok: true })
    }));

    const executor = new RuntimeExecutor(
        { chat: async () => ({ content: "", toolCalls: [] }) }, {});
    executor.setToolRegistry(registry);

    return executor;

}

test("L1-10a: pemanggil tak berizin dapat PERMISSION_DENIED — bukan VALIDATION_ERROR", async () => {

    const executor = makeExecutor();

    // Argumen sengaja kosong: bila validasi jalan lebih dulu, model akan
    // belajar bahwa tool ini butuh `vaultPath`. Otorisasi wajib menang
    // lebih dulu dan TANPA membocorkan schema.
    const result = await executor.runOne(
        { id: "c1", name: "vault_read", arguments: {} },
        null, null,
        { role: "user", channel: "console", sessionId: "l1-a" }
    );

    const error = result?.result?.error ?? {};

    assert.equal(error.code, "PERMISSION_DENIED",
        `harus PERMISSION_DENIED, dapat: ${error.code}`);
    assert.match(String(error.message ?? ""), /tidak diizinkan|Peran/i);
    assert.doesNotMatch(JSON.stringify(result), /vaultPath/,
        "schema argumen tool terlarang tidak boleh tersingkap");
});

test("L1-10b: capabilitySet di luar set juga ditolak SEBELUM validasi", async () => {

    const executor = makeExecutor();

    const result = await executor.runOne(
        { id: "c2", name: "vault_read", arguments: {} },
        null, null,
        { role: "system", channel: "autonomous", sessionId: "l1-b",
          capabilitySet: Object.freeze(["memory_recall"]) }
    );

    const error = result?.result?.error ?? {};

    assert.equal(error.code, "PERMISSION_DENIED");
    assert.match(String(error.details?.constraint ?? ""), /capability-set/);
    assert.doesNotMatch(JSON.stringify(result), /vaultPath/,
        "restriction-set tidak boleh mendapat pelajaran schema");
});

test("L1-10c: pemanggil berizin tetap divalidasi normal (argumen salah → VALIDATION_ERROR)", async () => {

    const executor = makeExecutor();

    const bad = await executor.runOne(
        { id: "c3", name: "vault_read", arguments: {} },
        null, null,
        { role: "superadmin", channel: "console", sessionId: "l1-c" }
    );
    assert.equal(bad?.result?.error?.code, "VALIDATION_ERROR",
        "otorisasi lolos → validasi schema berjalan seperti biasa");
    assert.match(JSON.stringify(bad), /vaultPath/,
        "pemanggil berizin memang melihat kebutuhan argumennya");

    const good = await executor.runOne(
        { id: "c4", name: "vault_read", arguments: { vaultPath: "x" } },
        null, null,
        { role: "superadmin", channel: "console", sessionId: "l1-d" }
    );
    assert.ok(!good?.result?.error,
        "panggilan sah dieksekusi normal");
});

test("L1-10d: ToolBus satu gerbang — urutan otorisasi > validasi juga di bus", async () => {

    const toolBus = require("../../src/autonomy/ToolBus");

    // vault_read tidak ada di registry AI uji → resolve gagal; pakai
    // tool nyata yang pasti ditolak untuk 'user' dengan args kosong:
    const out = await toolBus.execute({
        name: "terminal_run",
        args: {},                                  // schema butuh purpose+command
        timeoutMs: 5000,
        retries: 0,
        allowSubstitute: false,
        context: { exec: { role: "user", channel: "toolbus", sessionId: "l1-e" } }
    });

    assert.equal(out.ok, false);
    assert.match(String(out.error ?? ""), /ditolak otorisasi|tidak diizinkan|Peran/i,
        "penolakan harus dari GERBANG OTORISASI, bukan validator argumen");
});
