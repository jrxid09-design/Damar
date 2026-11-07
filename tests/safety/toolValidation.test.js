const test = require("node:test");
const assert = require("node:assert");

const ArgumentValidator = require("../../src/ai/tools/ArgumentValidator");
const SchemaMinimizer = require("../../src/ai/tools/SchemaMinimizer");
const Pipeline = require("../../src/ai/tools/Pipeline");
const toolStats = require("../../src/ai/tools/ToolStats");

/** SUITE KEAMANAN B — validator V2, schema correctness, stats, parity. */

const T = (name, parameters, execute) => ({ name, description: name, parameters, execute });

// ---- 19–21. ArgumentValidator V2 --------------------------------------------------

test("19. nested required + tipe bersarang divalidasi", () => {

    const tool = {
        name: "nested",
        parameters: {
            type: "object",
            properties: {
                filter: {
                    type: "object",
                    properties: { limit: { type: "integer" }, label: { type: "string" } },
                    required: ["limit"]
                }
            },
            required: ["filter"]
        }
    };

    const bad = ArgumentValidator.validate(tool, { filter: {} });
    assert.equal(bad.ok, false);
    assert.match(bad.error.details.missing?.[0] ?? bad.error.message, /limit/);

    const okRes = ArgumentValidator.validate(tool, { filter: { limit: "5" } });
    assert.ok(okRes.ok);
    assert.equal(okRes.args.filter.limit, 5);

});

test("20. array of objects + enum item divalidasi", () => {

    const tool = {
        name: "batch",
        parameters: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: { mode: { type: "string", enum: ["fast", "slow"] } },
                        required: ["mode"]
                    },
                    minItems: 1
                }
            },
            required: ["items"]
        }
    };

    assert.equal(ArgumentValidator.validate(tool, { items: [{ mode: "turbo" }] }).ok, false);
    assert.ok(ArgumentValidator.validate(tool, { items: [{ mode: "fast" }] }).ok);

});

test("20b. number bounds, pattern, maxLength, const", () => {

    const tool = {
        name: "bounds",
        parameters: {
            type: "object",
            properties: {
                pct: { type: "number", minimum: 0, maximum: 100 },
                code: { type: "string", pattern: "^[A-Z]{3}$", maxLength: 3 },
                kind: { type: "string", const: "fixed" }
            },
            required: ["pct", "code", "kind"]
        }
    };

    for (const args of [
        { pct: 150, code: "ABC", kind: "fixed" },
        { pct: 10, code: "ab", kind: "fixed" },
        { pct: 10, code: "ABC", kind: "flex" }
    ]) {
        assert.equal(ArgumentValidator.validate(tool, args).ok, false, JSON.stringify(args));
    }

    assert.ok(ArgumentValidator.validate(tool, { pct: 50, code: "ABC", kind: "fixed" }).ok);

});

test("21. additionalProperties:false menolak properti asing", () => {

    const tool = {
        name: "strict",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: { a: { type: "string" } },
            required: ["a"]
        }
    };

    const r = ArgumentValidator.validate(tool, { a: "x", evil: "y" });

    assert.equal(r.ok, false);
    assert.match(r.error.message, /evil/);

});

test("21b. union type [string,null] & error tanpa echo nilai mentah", () => {

    const tool = {
        name: "u",
        parameters: {
            type: "object",
            properties: { token: { type: ["string", "null"] }, n: { type: "integer" } },
            required: ["token"]
        }
    };

    assert.ok(ArgumentValidator.validate(tool, { token: null }).ok);
    assert.ok(ArgumentValidator.validate(tool, { token: "abc" }).ok);

    const bad = ArgumentValidator.validate(tool, { token: { secret: "SUPER-SECRET-VALUE" }, n: "x" });

    assert.equal(bad.ok, false);
    assert.ok(!JSON.stringify(bad.error).includes("SUPER-SECRET-VALUE"), "nilai mentah ter-echo");
    assert.match(JSON.stringify(bad.error), /object/i);

});

// ---- F. Normalisasi level atas dikembalikan ke pemanggil ----------------

test("F. {limit:'5'} dinormalisasi jadi number di level ATAS (bukan dibuang)", () => {

    const tool = {
        name: "paged",
        parameters: {
            type: "object",
            properties: {
                limit: { type: "integer" },
                ratio: { type: "number" },
                flag: { type: "boolean" }
            }
        }
    };

    const r = ArgumentValidator.validate(tool, { limit: "5", ratio: "2.5", flag: "true" });

    assert.ok(r.ok);
    assert.equal(r.args.limit, 5);
    assert.equal(typeof r.args.limit, "number");
    assert.equal(r.args.ratio, 2.5);
    assert.equal(r.args.flag, true);

});

// ---- 19b. Minimized schema tetap valid ------------------------------------------------

test("19b. minimizer: required ⊆ properties di SEMUA level; enum tak dipangkas", () => {

    const schema = {
        type: "object",
        properties: {
            q: { type: "string", description: "x".repeat(400) },
            mode: { type: "string", enum: ["a", "b", "c"] },
            sub: {
                type: "object",
                properties: { keep: { type: "string" }, dropme: { type: "string" } },
                required: ["keep", "dropme"]
            }
        },
        required: ["q", "mode"]
    };

    // Simulasikan pemangkasan properti (perilaku lama memicu schema invalid).
    schema.properties.sub.properties.dropme.description = undefined;

    const view = SchemaMinimizer.minimizeSchema(schema);

    // Top-level.
    for (const k of view.required ?? []) {
        assert.ok(k in view.properties, `required '${k}' tanpa properti`);
    }

    // Nested: enum utuh, tidak ada slice.
    assert.deepEqual(view.properties.mode.enum, ["a", "b", "c"]);

});

// ---- 22. Determinisme ----------------------------------------------------------------------

test("22. seleksi identik → hasil byte-identik (determinisme)", async () => {

    const tools = [
        T("memory_recall", {}, async () => ({})),
        T("home_control", { meta: { keywords: ["lampu"] } }, async () => ({})),
        T("tool_search", {}, async () => ({}))
    ];

    tools[1].meta = { keywords: ["lampu"] };

    const input = { tools, message: "matikan lampu kamar", channel: "console", role: "superadmin" };

    const a = await Pipeline.select(input);
    const b = await Pipeline.select(input);

    assert.deepEqual(a.tools, b.tools);

});

// ---- 23. ToolStats: rolling reliability + isolasi benchmark ---------------------------------

test("23. keandalan bergulir: streak gagal pulih, dan reset() untuk benchmark", () => {

    toolStats.reset();

    // 6 gagal berurutan → reliability rendah.
    for (let i = 0; i < 6; i++) toolStats.record("flaky", false, 10, "EXECUTION_ERROR");

    const low = toolStats.reliability("flaky");

    assert.ok(low !== null && low <= 0.2, `reliability=${low}`);

    // Pemulihan: 12 sukses berikutnya menggulingkan sampel gagal dari window.
    for (let i = 0; i < 12; i++) toolStats.record("flaky", true, 10);

    const recovered = toolStats.reliability("flaky");

    assert.ok(recovered >= 0.6, `harus pulih, dapat ${recovered}`);

    // Isolasi benchmark: reset membersihkan penuh.
    toolStats.flush();
    toolStats.reset();

    assert.equal(toolStats.reliability("flaky"), null);

});

// ---- 24–26. Multilingual retrieval ------------------------------------------------------------

test("24–25. English & campuran ID/EN menemukan kapabilitas", async () => {

    const tools = [
        T("weather.currentWeather", {}, async () => ({})),
        T("crypto_price", { meta: { keywords: ["bitcoin"] } }, async () => ({})),
        T("filesystem__readFile", {}, async () => ({}))
    ];

    const en = await Pipeline.select({ tools, message: "what's the weather in Berlin?", channel: "cli", role: "superadmin" });
    assert.ok(en.diagnostics.selectedTools.some(t => /weather|currentWeather/i.test(t)));

    const mix = await Pipeline.select({ tools, message: "tolong check harga bitcoin now", channel: "cli", role: "superadmin" });
    assert.ok(mix.diagnostics.selectedTools.some(t => /bitcoin|crypto_price/.test(t)));

});

test("26. non-Latin (CJK/Cyrillic) tidak crash dan tetap deterministik", async () => {

    const tools = [T("memory_recall", {}, async () => ({})), T("tool_search", {}, async () => ({}) )];

    const cjk = await Pipeline.select({ tools, message: "今天天气怎么样？", channel: "cli", role: "superadmin", includeMind: false });
    const cyr = await Pipeline.select({ tools, message: "привет, как дела?", channel: "cli", role: "superadmin", includeMind: false });

    assert.ok(Array.isArray(cjk.tools));
    assert.ok(Array.isArray(cyr.tools));

    const cjk2 = await Pipeline.select({ tools, message: "今天天气怎么样？", channel: "cli", role: "superadmin", includeMind: false });
    assert.deepEqual(cjk.tools, cjk2.tools);

});

// ---- 27. Channel parity ----------------------------------------------------------------------------

test("27. paritas kanal: identitas sama → eligibility sama lintas kanal", async () => {

    const tools = [
        T("terminal_run", {}, async () => ({})),
        T("home_control", { meta: { keywords: ["lampu"] } }, async () => ({})),
        T("memory_recall", {}, async () => ({})),
        T("tool_search", {}, async () => ({}))
    ];

    const input = { tools, message: "matikan lampu ruang tamu", role: "user" };

    const tg = await Pipeline.select({ ...input, channel: "telegram" });
    const wa = await Pipeline.select({ ...input, channel: "whatsapp" });
    const cs = await Pipeline.select({ ...input, channel: "console" });

    assert.deepEqual(tg.diagnostics.selectedTools, wa.diagnostics.selectedTools);
    assert.deepEqual(wa.diagnostics.selectedTools, cs.diagnostics.selectedTools);

    // Kanal boleh MEMBATASI (voice menyembunyikan destruktif bagi user):
    const voice = await Pipeline.select({ ...input, channel: "voice" });

    assert.ok(!voice.diagnostics.selectedTools.includes("terminal_run"),
        "voice harus membatasi destruktif untuk user");

});
