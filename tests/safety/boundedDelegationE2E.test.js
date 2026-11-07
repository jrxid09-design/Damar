const test = require("node:test");
const assert = require("node:assert");

/**
 * I — BOUNDED DELEGATION END-TO-END lewat JALUR RUNTIME NYATA.
 *
 * Bukan identitas rakitan: grant watchdog kanonik mengalir
 *   Watchdog.escalateAutonomously
 *     → SelfHealingEngine.recover (resolveDelegator internal:true)
 *       → AgentHub.run → runDamar
 *         → aiRuntimeService.chat (request construction nyata)
 *           → AIRuntime.chat → RuntimeExecutor loop
 *             → ToolExecutor → Authorization.identity/assertExecution
 *
 * Yang di-stub HANYA respons model (provider skripted) dan pemilihan
 * provider aktif — tidak ada identitas buatan produksi.
 */

// ---- Harness: provider aktif diarahkan ke otak lokal tanpa jaringan ----
const providerConfigService = require("../../src/services/providerConfigService");
providerConfigService.resolveActive = () => ({
    kind: "llamacpp",
    id: "llamacpp",
    label: "test-local",
    model: null,
    baseUrl: null,
    apiKey: null
});

const aiRuntime = require("../../src/services/aiRuntimeService");
aiRuntime.initialize();

// Tool plugin NYATA didaftarkan ke registry inti — bentuk yang sama
// dengan plugin damarSkills produksi, sehingga bridging, index, dan
// gerbang melihat nama model-facing yang sesungguhnya.
const { ToolRegistry } = require("../../src/core/tools");

const executed = [];

function registerProbeSkill(name, parameters, result) {
    ToolRegistry.register("damarSkills", {
        name,
        description: `Probe uji: ${name}.`,
        parameters,
        execute: async (args) => {
            executed.push({ name: `damarSkills.${name}`, args });
            return typeof result === "function" ? result(args) : result;
        }
    });
}

registerProbeSkill(
    "system_health", {}, { cpu: 1, ram: 2, ok: true });
registerProbeSkill(
    "wa_send",
    { number: { type: "string", required: true }, text: { type: "string", required: true } },
    { sent: true });
registerProbeSkill(
    "wa_broadcast",
    { text: { type: "string", required: true } },
    { recipients: ["628100000000"] });

aiRuntime.refreshTools();

// ---- Provider skripted: satu-satunya stub ------------------------------
class ScriptedProvider {
    constructor() { this.script = []; this.requests = []; }
    async chat(request) {
        this.requests.push(request);
        const step = this.script.shift();
        if (!step) {
            return { content: "(tidak ada langkah lagi)", toolCalls: [], usage: {} };
        }
        if (step.capture) step.capture(request);
        return step;
    }
    async *stream() { /* tidak dipakai jalur ini */ }
}

const provider = new ScriptedProvider();
const engine = aiRuntime.ensure();
engine.registerProvider("scripted", provider);
engine.use("scripted");
engine.runtime.setDefaultModel("scripted-model");

const { Watchdog } = require("../../src/autonomy/watchdog");
const healing = require("../../src/autonomy/SelfHealingEngine");
const agentHub = require("../../src/services/agentHub");
const Authorization = require("../../src/ai/tools/Authorization");

const toolResultsOf = (request) =>
    (request.messages ?? [])
        .filter(m => m.role === "tool")
        .map(m => ({ name: m.name, content: m.content }));

test("I/E2E: grant watchdog membawa capabilitySet sampai ke request runtime", async () => {

    let execSeenAtRuntime = null;

    provider.script = [{
        capture: req => { execSeenAtRuntime = req.exec; },
        toolCalls: []
    }, {
        content: "selesai"
    }];

    await healing.recover({
        tool: "agent:damar",
        action: "diagnosa uji bounded delegation",
        error: new Error("mcp offline"),
        goalId: null,
        requirement: "uji",
        internal: true,
        capabilitySet: Watchdog.RECOVERY_CAPABILITIES
    });

    // CRITICAL-1: set TIDAK lenyap di hop agentHub→aiRuntime→AIRuntime.
    assert.ok(execSeenAtRuntime, "request runtime harus terekam");
    assert.deepEqual(
        [...(execSeenAtRuntime.capabilitySet ?? [])],
        [...Watchdog.RECOVERY_CAPABILITIES],
        "capabilitySet watchdog wajib sampai utuh ke request runtime");
    assert.equal(Object.isFrozen(execSeenAtRuntime.capabilitySet), true,
        "set harus dibekukan sebelum masuk gerbang");
    assert.equal(execSeenAtRuntime.role, "system",
        "grant kanonik internal:true memang menghasilkan peran system");

});

test("I/E2E: gerbang eksekusi menolak kapabilitas luar set pada jalur model nyata", async () => {

    executed.length = 0;
    provider.requests.length = 0;

    const DENIED_PROBES = [
        ["terminal_run", { purpose: "diag", command: "whoami" }],
        ["create_tool", { id: "jahat", name: "jahat", tool_name: "jahat", code: "return 1;" }],
        ["kali_run", { command: "echo uji" }],
        ["goal_run", { title: "eskalasi uji" }],
        ["damarSkills__wa_send", { number: "628100000000", text: "salam dari watchdog" }],
        ["damarSkills__wa_broadcast", { text: "broadcast" }]
    ];

    provider.script = DENIED_PROBES.map(([name, args], i) => ({
        toolCalls: [{ id: `d${i}`, name, arguments: args }]
    })).concat([{ content: "Pemulihan dibatasi lingkupnya; laporan menyusul." }]);

    const outcome = await healing.recover({
        tool: "agent:damar",
        action: "diagnosis dengan percobaan eskalasi di luar set",
        error: new Error("layanan gagal"),
        goalId: null,
        requirement: "uji penolakan",
        internal: true,
        capabilitySet: Watchdog.RECOVERY_CAPABILITIES
    });

    // Model menjawab (jalur pulih tetap hidup), tapi...
    assert.equal(outcome.outcome.ok, true);

    const firstRequest = provider.requests[0];
    const results = toolResultsOf(firstRequest);

    for (const [name] of DENIED_PROBES) {
        const r = results.find(x => x.name === name);
        assert.ok(r, `${name} harus punya hasil terstruktur`);
        assert.match(r.content, /PERMISSION_DENIED/,
            `${name} wajib ditolak gerbang`);
        assert.match(r.content, /capability-set/,
            `${name} ditolak JELAS karena capability set`);
    }

    // TIDAK ADA eksekusi nyata di luar set:
    assert.deepEqual(executed.filter(e =>
        e.name !== "damarSkills.system_health"),
        [], "nol eksekusi di luar himpunan pemulihan");

});

test("I/E2E: anggota set dieksekusi normal pada jalur yang sama", async () => {

    executed.length = 0;
    provider.requests.length = 0;

    provider.script = [
        { toolCalls: [{ id: "m1", name: "memory_recall", arguments: { query: "status layanan" } }] },
        { toolCalls: [{ id: "m2", name: "damarSkills__system_health", arguments: {} }] },
        { content: "Diagnosa selesai." }
    ];

    await healing.recover({
        tool: "agent:damar",
        action: "diagnosa anggota set",
        error: new Error("x"),
        goalId: null,
        requirement: "uji anggota",
        internal: true,
        capabilitySet: Watchdog.RECOVERY_CAPABILITIES
    });

    const names = executed.map(e => e.name);
    assert.ok(names.includes("damarSkills.system_health"),
        "anggota set (bridged) dieksekusi nyata");

    const results = toolResultsOf(provider.requests[0]);
    const health = results.find(r => r.name === "damarSkills__system_health");
    assert.ok(health && !/error/i.test(health.content),
        "hasil anggota set sukses");
    assert.doesNotMatch(
        JSON.stringify(results.find(r => r.name === "tool_search") ?? {}),
        /PERMISSION_DENIED/);

});

test("I/E2E: disklosur giliran terikat set — model tidak MELIHAT di luar set", async () => {

    provider.requests.length = 0;
    provider.script = [{ content: "ok" }];

    await aiRuntime.chat({
        messages: [{ role: "user", content: "periksa kesehatan sistem" }],
        role: "system",
        sessionId: "e2e-disclosure",
        capabilitySet: Watchdog.RECOVERY_CAPABILITIES
    });

    const req = provider.requests[0];
    const attached = (req.tools ?? []).map(t => t.name);

    const FORBIDDEN = [
        "terminal_run", "create_tool", "skill_build", "goal_run",
        "kali_run", "damarSkills__wa_send", "damarSkills__wa_broadcast",
        "filesystem__writeFile", "filesystem__deleteFile"
    ];

    for (const f of FORBIDDEN) {
        assert.ok(!attached.includes(f),
            `${f} tidak boleh terdisklosur di dalam set`);
    }

    // tool_search boleh terlihat HANYA bila termasuk set (di sini ya).
    assert.ok(attached.includes("tool_search"),
        "tool_search adalah anggota set");

});

test("I/F: assertion runtime menangkap pelucutan restriction (regresi wiring)", () => {

    assert.throws(
        () => agentHub.assertRestrictionsPreserved(
            { capabilitySet: Watchdog.RECOVERY_CAPABILITIES },
            { messages: [], role: "system" }),
        /INVARIAN/,
        "request tanpa capabilitySet harus GAGAL KERAS");

    assert.doesNotThrow(() =>
        agentHub.assertRestrictionsPreserved(
            { capabilitySet: Watchdog.RECOVERY_CAPABILITIES },
            { messages: [], role: "system", capabilitySet: Watchdog.RECOVERY_CAPABILITIES }));

});

test("I/A: identitas ternormalisasi mempertahankan restriction lintas serialisasi", () => {

    const original = {
        role: "system",
        channel: "autonomous",
        sessionId: "hop-test",
        capabilitySet: [...Watchdog.RECOVERY_CAPABILITIES]
    };

    // Simulasi hop JSON (HTTP/MCP/queue): symbol hilang, array tetap.
    const throughJson = JSON.parse(JSON.stringify(original));
    const id1 = Authorization.identity(original);
    const id2 = Authorization.identity(throughJson);

    assert.deepEqual([...id1.capabilitySet], [...Watchdog.RECOVERY_CAPABILITIES]);
    assert.deepEqual([...id2.capabilitySet], [...Watchdog.RECOVERY_CAPABILITIES],
        "restriction wajib selamat normalisasi & serialisasi");
    assert.ok(Object.isFrozen(id2.capabilitySet));

    // Irisan saja, tidak pernah union:
    const narrowed = Authorization.identity({
        ...original,
        capabilitySet: Authorization.intersectCapabilitySets(
            original.capabilitySet, ["memory_recall"])
    });
    assert.deepEqual([...narrowed.capabilitySet], ["memory_recall"]);

});
