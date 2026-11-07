const test = require("node:test");
const assert = require("node:assert");

/**
 * CLOSURE — INVARIANT IDENTITAS (H1 + M3) di JALUR RUNTIME NYATA.
 *
 * Yang di-stub HANYA respons model (provider skripted) dan pemilihan
 * provider aktif. Identitas selalu identitas produksi:
 *   - H1: chat()/stream() langsung ke AIRuntime dengan role+
 *     capabilitySet TANPA exec → restriction wajib selamat.
 *   - M3: setiap nested turn (fallback lokal, think_deeply, pemulihan
 *     SelfHealing via ToolBus) mewarisi identitas — bukan hop pelucutan.
 */

// ---- Harness (pola boundedDelegationE2E) --------------------------------
const providerConfigService = require("../../src/services/providerConfigService");
providerConfigService.resolveActive = () => ({
    kind: "llamacpp",
    id: "llamacpp",
    label: "test-local",
    model: null,
    baseUrl: null,
    apiKey: null
});
// Vision tidak boleh menyasar API Google sungguhan dalam uji.
providerConfigService.read = () => ({ providers: { google: { apiKey: "dummy" } } });

const aiRuntime = require("../../src/services/aiRuntimeService");
aiRuntime.initialize();

const { ToolRegistry } = require("../../src/core/tools");

const executed = [];

function registerProbeSkill(name, parameters, result) {
    ToolRegistry.register("damarSkills", {
        name,
        description: `Probe closure: ${name}.`,
        parameters,
        execute: async (args) => {
            executed.push({ name: `damarSkills.${name}`, args });
            return typeof result === "function" ? result(args) : result;
        }
    });
}

registerProbeSkill("closure_health", {}, { ok: true, cpu: 1 });
registerProbeSkill("wa_send",
    { number: { type: "string", required: true }, text: { type: "string", required: true } },
    { sent: true });

aiRuntime.refreshTools();

class ScriptedProvider {
    constructor() { this.script = []; this.requests = []; }
    async chat(request) {
        this.requests.push(request);
        const step = this.script.shift();
        if (!step) return { content: "(habis)", toolCalls: [], usage: {} };
        return step;
    }
    async *stream(request) {
        this.requests.push(request);
        const step = this.script.shift();
        yield {
            delta: step?.content ?? "", toolCalls: [],
            finishReason: "stop", usage: {}, done: true
        };
    }
}

const provider = new ScriptedProvider();
const engine = aiRuntime.ensure();
engine.registerProvider("scripted-closure", provider);
engine.use("scripted-closure");
engine.runtime.setDefaultModel("scripted-model");

const Authorization = require("../../src/ai/tools/Authorization");

function toolResultsOf(request) {
    return (request.messages ?? [])
        .filter(m => m.role === "tool")
        .map(m => ({ name: m.name, content: m.content }));
}

// ---- 1+2. AIRuntime DIRECT: bounded disclosure & execution --------------

test("H1-1: AIRuntime direct chat dengan role+capabilitySet → disclosure ⊆ set", async () => {

    provider.requests.length = 0;
    provider.script = [{ content: "siap" }];

    // PERSIS reproduksi Claude: tanpa request.exec, hanya role+set.
    await engine.chat({
        messages: [{ role: "user", content: "ingat sesuatu" }],
        role: "superadmin",
        capabilitySet: ["memory_recall"]
    });

    const req = provider.requests[0];

    assert.ok(req.exec, "identitas kanonik harus dibangun runtime");
    assert.deepEqual([...req.exec.capabilitySet], ["memory_recall"],
        "capabilitySet wajib selamat di jalur direct");
    assert.equal(Object.isFrozen(req.exec.capabilitySet), true,
        "restriction harus dibekukan sebelum gerbang");

    const disclosed = (req.tools ?? []).map(t => t.name);
    assert.ok(disclosed.length > 0, "minimal satu anggota set terlihat");
    for (const n of disclosed) {
        assert.ok(
            Authorization.capSetWithin(n, req.exec.capabilitySet),
            `tool '${n}' terdisklosur DI LUAR capabilitySet`);
    }
    assert.ok(disclosed.includes("memory_recall"),
        "anggota set tetap harus terlihat");
});

test("H1-2: AIRuntime direct chat → execution ⊆ set (di luar set DENY)", async () => {

    executed.length = 0;
    provider.requests.length = 0;

    const SET = ["damarSkills.closure_health"];

    provider.script = [
        { toolCalls: [{ id: "b1", name: "terminal_run", arguments: { purpose: "x", command: "whoami" } }] },
        { toolCalls: [{ id: "b2", name: "damarSkills__closure_health", arguments: {} }] },
        { content: "selesai" }
    ];

    await engine.chat({
        messages: [{ role: "user", content: "diagnosa" }],
        role: "system",
        capabilitySet: SET
    });

    const results = toolResultsOf(provider.requests[0]);
    const byName = Object.fromEntries(results.map(r => [r.name, r.content]));

    assert.match(byName["terminal_run"] ?? "", /PERMISSION_DENIED/,
        "tool di luar set wajib ditolak gerbang eksekusi");
    assert.match(byName["terminal_run"] ?? "", /capability-set/,
        "penolakan karena capability set, bukan alasan lain");
    assert.doesNotMatch(byName["damarSkills__closure_health"] ?? "", /error/i,
        "anggota set dieksekusi normal pada jalur yang sama");
    assert.ok(executed.some(e => e.name === "damarSkills.closure_health"),
        "eksekusi anggota set benar-benar terjadi");
});

test("H1-2b: AIRuntime direct stream paritas dengan chat", async () => {

    provider.requests.length = 0;
    provider.script = [];

    for await (const chunk of engine.stream({
        messages: [{ role: "user", content: "halo" }],
        role: "superadmin",
        capabilitySet: ["memory_recall"],
        stream: true
    })) {
        if (chunk.done) break;
    }

    const req = provider.requests[0];
    assert.ok(req.exec?.capabilitySet, "stream bukan hop pelucutan");
    assert.deepEqual([...req.exec.capabilitySet], ["memory_recall"]);
    const disclosed = (req.tools ?? []).map(t => t.name);
    for (const n of disclosed) {
        assert.ok(Authorization.capSetWithin(n, req.exec.capabilitySet),
            `stream mendisklosur '${n}' di luar set`);
    }
});

// ---- 3. visionService nested turn membawa exec kanonik ------------------

test("H1-3: visionService meneruskan SATU exec kanonik (bukan role+set terpisah)", async () => {

    process.env.DAMAR_VISION_MODEL = "vision-test-model";

    try {
        const vision = require("../../src/services/visionService");

        provider.requests.length = 0;
        provider.script = [{ content: "ada kucing" }];

        const out = await vision.analyze({
            imageBase64: Buffer.from("gambar").toString("base64"),
            prompt: "apa ini?",
            exec: { role: "superadmin", sessionId: "vis-1", capabilitySet: ["memory_recall"] }
        });

        assert.ok(out.text, "vision menjawab lewat provider skripted");

        const req = provider.requests[0];
        assert.equal(req.exec.role, "superadmin",
            "peran delegator mewarisi giliran visi");
        assert.deepEqual([...(req.exec.capabilitySet ?? [])], ["memory_recall"],
            "restriction delegasi ikut ke giliran visi");
        // Bentuk panggilan BARU: exec utuh — bukan role/capabilitySet
        // terpisah di level atas request.
        assert.equal(req.role, undefined,
            "vision tidak lagi mengirim role terpisah — satu exec kanonik");
    }
    finally {
        delete process.env.DAMAR_VISION_MODEL;
    }

});

// ---- 4. chatLocalFallback mempertahankan identitas ----------------------

test("M3-4: fallback provider lokal BUKAN hop pelucutan identitas", async () => {

    executed.length = 0;
    provider.requests.length = 0;

    // Jalur "lokal" juga diskriptakan: daftarkan provider id llamacpp
    // (menimpa jaring pengaman nyata agar uji tetap offline deterministik).
    const localProvider = new ScriptedProvider();
    engine.registerProvider("llamacpp", localProvider);
    localProvider.script = [{ content: "jawab lokal" }];

    const local = await aiRuntime.chatLocalFallback(
        {
            messages: [{ role: "user", content: "tugas" }],
            temperature: 0.2,
            maxTokens: 64,
            tools: [],
            exec: {
                role: "superadmin",
                channel: "console",
                sessionId: "fb-1",
                principalId: "fb-1",
                capabilitySet: Authorization.normalizeCapabilitySet(["memory_recall"])
            }
        },
        "openai",
        { status: 429, message: "quota" }
    );

    assert.ok(local, "fallback lokal mengembalikan jawaban");

    const req = localProvider.requests[0];
    assert.ok(req, "permintaan giliran lokal terekam");
    assert.equal(req.exec.role, "superadmin",
        "ganti provider ≠ lucuti peran");
    assert.deepEqual([...(req.exec.capabilitySet ?? [])], ["memory_recall"],
        "restriction selamat melewati fallback lokal");
    assert.equal(Object.isFrozen(req.exec.capabilitySet), true);

    // Dan restriction benar-benar ditegakkan di giliran fallback:
    assert.ok((req.tools ?? []).every(t =>
        Authorization.capSetWithin(t.name, req.exec.capabilitySet)),
        "disklosur giliran fallback ⊆ set");
});

// ---- 5. think_deeply mewarisi identitas giliran pemanggil ----------------

test("M3-5: think_deeply nested turn membawa exec (role + capabilitySet)", async () => {

    provider.requests.length = 0;
    provider.script = [{ content: "analisis mendalam" }];

    const registry = engine.runtime.getToolRegistry();
    const thinkDeeply = registry.get("think_deeply");
    assert.ok(thinkDeeply, "think_deeply terdaftar");

    const out = await thinkDeeply.execute(
        { masalah: "pilih arsitektur A atau B" },
        { exec: { role: "admin", sessionId: "td-1", capabilitySet: ["memory_recall"] } }
    );

    assert.equal(out.ok, true);

    const req = provider.requests[0];
    assert.equal(req.exec.role, "admin",
        "putaran renungan mewarisi peran pemanggil, bukan user default");
    assert.deepEqual([...(req.exec.capabilitySet ?? [])], ["memory_recall"],
        "restriction ikut ke putaran renungan");
});

// ---- 6. SelfHealing → ToolBus nested execution tunduk pada set ----------

test("M3-6a: pemulihan transient menyalakan identitas sampai ke ToolBus", async () => {

    executed.length = 0;

    const healing = require("../../src/autonomy/SelfHealingEngine");

    const outcome = await healing.recover({
        tool: "damarSkills__closure_health",
        args: {},
        error: new Error("ETIMEDOUT timeout sementara"),
        goalId: "g-closure",
        internal: true,
        capabilitySet: ["damarSkills.closure_health"]
    });

    assert.equal(outcome.klass, "transient");
    assert.equal(outcome.outcome.ok, true, "anggota set dipulihkan lewat ToolBus");
    assert.ok(executed.some(e => e.name === "damarSkills.closure_health"),
        "eksekusi nyata lewat bus dengan identitas delegasi");
});

test("M3-6b: ToolBus nested MENOLAK kapabilitas luar set warisan pemulihan", async () => {

    executed.length = 0;

    const healing = require("../../src/autonomy/SelfHealingEngine");

    const outcome = await healing.recover({
        tool: "damarSkills__closure_health",
        args: {},
        error: new Error("ETIMEDOUT timeout sementara"),
        goalId: "g-closure-deny",
        internal: true,
        capabilitySet: ["tool_search"]
    });

    assert.equal(outcome.klass, "transient");
    assert.equal(outcome.outcome.ok, false,
        "tool di luar set warisan TIDAK boleh tereksekusi lewat bus");
    assert.match(String(outcome.outcome.error ?? ""), /ditolak otorisasi|capability-set/i,
        "penolakan berasal dari gerbang otorisasi, bukan kegagalan teknis");
    assert.equal(executed.length, 0, "tidak ada eksekusi yang terjadi");
});

// ---- M3: enumerasi repo-wide situs nested-turn ber-identitas -------------
//
// DEFENSE-IN-DEPTH SAJA (M-1 review): bukti keamanan tetap behavioral
// lewat m1RestrictionPreservation, boundedDelegationE2E,
// capabilitySetParity, dan probe runtime closureIdentity. Enumerasi
// ini hanya mengunci MEKANISME KANONIK terkini (Authorization.
// toCapabilitySet) di setiap situs penerusan restriction — BUKAN
// bentuk implementasi lampau; Array.isArray tidak boleh kembali.

test("M3-ENUM: semua situs nested-turn ber-identitas membawa restriction", () => {

    const fs = require("node:fs");
    const path = require("node:path");
    const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");

    // [berkas, pola bukti identitas/restriction kanonik, jumlah minimal]
    const SITES = [
        // chatLocalFallback: kedua titik panggil menyertakan exec...
        ["src/services/aiRuntimeService.js",
         /chatLocalFallback\(\s*\{[^}]*exec\s*[},]/g, 2],
        // ...dan body fallback meneruskan request (termasuk exec) utuh.
        ["src/services/aiRuntimeService.js",
         /await engine\.chat\(\{\s*\.\.\.request/g, 1],
        // Batas runtime chat/stream menormalkan restriction fail-closed.
        ["src/services/aiRuntimeService.js",
         /toCapabilitySet\(/g, 2],
        // think_deeply menyeberangkan identitas kanonik giliran.
        ["src/consciousness/tools.js", /\bexec:\s*turnExec\b/, 1],
        // SelfHealingEngine: SETIAP toolBus.execute membawa delegator.
        ["src/autonomy/SelfHealingEngine.js",
         /context:\s*\{\s*goal:\s*goalId,\s*exec:\s*delegator\s*\}/g, 2],
        // GoalEngine: planner/evaluator/spec mewarisi restriction.
        ["src/autonomy/GoalEngine.js",
         /turnRestrictions\(delegator\)/g, 3],
        // Orchestrator: plan & sintesis menormalkan restriction kanonik.
        ["src/services/orchestrator.js",
         /toCapabilitySet\(exec\?\.capabilitySet\)/g, 2],
        // agentHub: pelestarian restriction + attach di tiga situs.
        ["src/services/agentHub.js",
         /assertRestrictionsPreserved\(/, 1],
        ["src/services/agentHub.js",
         /toCapabilitySet\(exec\?\.capabilitySet\)/g, 3],
        // AIRuntime: satu identitas kanonik untuk chat & stream.
        ["src/ai/runtime/AIRuntime.js",
         /canonicalRequestExec\(request\)/g, 3]
    ];

    const missing = [];
    for (const [file, pattern, min] of SITES) {
        const hits = read(...file.split("/")).match(pattern)?.length ?? 0;
        if (hits < min) {
            missing.push(`${file}: butuh ≥${min} bukti '${pattern}', dapat ${hits}`);
        }
    }

    // NEGATIF (M-1): bentuk gerbang lama yang melucuti restriction
    // tidak boleh kembali di file penerus mana pun.
    const NO_LEGACY_GATE = [
        "src/services/orchestrator.js",
        "src/services/contextService.js",
        "src/autonomy/GoalEngine.js",
        "src/autonomy/SelfHealingEngine.js",
        "src/services/agentHub.js",
        "src/services/aiRuntimeService.js",
        "src/ai/runtime/AIRuntime.js"
    ];
    for (const f of NO_LEGACY_GATE) {
        if (/Array\.isArray\([A-Za-z_$][\w$?.]*capabilitySet/.test(read(...f.split("/")))) {
            missing.push(`${f}: gerbang Array.isArray(...capabilitySet) terlarang — gunakan Authorization.toCapabilitySet`);
        }
    }

    assert.deepEqual(missing, [],
        `situs nested-turn kehilangan bukti identitas:\n${missing.join("\n")}`);
});
