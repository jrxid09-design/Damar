const test = require("node:test");
const assert = require("node:assert");

/**
 * M-1 CLOSURE — FAIL-OPEN DI MEKANISME PELESTARIAN RESTRICTION.
 *
 * Cabang persisnya (sebelum ditutup):
 *   agentHub.assertRestrictionsPreserved: precondition-nya adalah
 *   Array.isArray(exec?.capabilitySet) sendiri → restriction berbentuk
 *   non-array (id string tunggal, Set programatik dari Capability
 *   Lifecycle/ACC, hasil serialisasi rusak) MELOLEWATI asersi;
 *   bersama cabang Array.isArray yang sama di
 *   Authorization.resolveDelegator, set LENYAP di hop delegasi dan
 *   identitas menjadi PRIVILEGED + UNRESTRICTED.
 *
 * Semantik baru (Authorization.toCapabilitySet):
 *   PRESERVE (array sah) | NARROW (string id / iterable) |
 *   FAIL CLOSED (bentuk tak dikenal → THROW).
 */

const Authorization = require("../../src/ai/tools/Authorization");
const {
    resolveDelegator, identity, toCapabilitySet,
    hasRestriction, assertExecution, isCanonicalInternalGrant
} = Authorization;

const INVARIANT = /PELANGGARAN INVARIAN/i;

// ---- 1. REGRESI CABANG PERSIS M-1 ---------------------------------------

test("M1: resolveDelegator TIDAK lagi melucuti restriction berbentuk non-array", () => {

    // Bentuk dulu: Array.isArray gagal → set dibuang → superadmin polos.
    for (const malformed of [{ acc: "all" }, 42, true]) {
        assert.throws(
            () => resolveDelegator({
                role: "superadmin",
                sessionId: "m1",
                capabilitySet: malformed
            }),
            INVARIANT,
            `restriction ${JSON.stringify(malformed)} wajib fail-closed`
        );
    }

    // Bentuk dapat-dipersempit: selamat sebagai himpunan, bukan lenyap.
    const fromString = resolveDelegator({
        role: "superadmin", sessionId: "m1", capabilitySet: "memory_recall"
    });
    assert.equal(fromString.role, "superadmin");
    assert.deepEqual([...fromString.capabilitySet], ["memory_recall"]);
    assert.equal(Object.isFrozen(fromString.capabilitySet), true);

    const fromSet = resolveDelegator({
        role: "admin", sessionId: "m1",
        capabilitySet: new Set(["memory_recall", "tool_search"])
    });
    assert.deepEqual([...fromSet.capabilitySet].sort(),
        ["memory_recall", "tool_search"]);
});

test("M1: asersi pelestarian tidak lagi mematikan dirinya sendiri", () => {

    const agentHub = require("../../src/services/agentHub");

    const parent = {
        role: "system",
        capabilitySet: new Set(["memory_recall", "tool_search"])
    };

    // CABANG PERSIS M-1: dulu precondition Array.isArray(parent)=false
    // → child TANPA set lolos diam-diam. Kini gagal-keras.
    assert.throws(
        () => agentHub.assertRestrictionsPreserved(parent, {}),
        /hilang|PELANGGARAN/i
    );

    // Pelestarian sah: sama atau lebih sempit.
    assert.doesNotThrow(() =>
        agentHub.assertRestrictionsPreserved(parent, {
            capabilitySet: ["memory_recall", "tool_search"]
        }));
    assert.doesNotThrow(() =>
        agentHub.assertRestrictionsPreserved(parent, {
            capabilitySet: "memory_recall"          // narrowing bentuk lain
        }));

    // Melebar TIDAK boleh.
    assert.throws(
        () => agentHub.assertRestrictionsPreserved(parent, {
            capabilitySet: ["memory_recall", "terminal_run"]
        }),
        /MELEBAR/
    );
});

test("M1-MEKANISME: tabel behavioral persis review M-1", () => {

    const agentHub = require("../../src/services/agentHub");
    const PARENT = ["memory_recall"];
    const run = (child) => {
        let err = null;
        try {
            agentHub.assertRestrictionsPreserved(
                { role: "system", capabilitySet: PARENT },
                child === undefined ? {} : { capabilitySet: child });
        }
        catch (e) { err = e; }
        return err;
    };

    // parent ["memory_recall"] → child ["memory_recall"] : PELESTARIAN
    assert.equal(run(["memory_recall"]), null);

    // parent ["memory_recall"] → child [] : NARROWING sah (terkunci penuh)
    assert.equal(run([]), null,
        "set kosong = mempersempit, bukan menghilangkan");

    // parent ["memory_recall"] → child + terminal_run : DENY (melebar)
    const widen = run(["memory_recall", "terminal_run"]);
    assert.match(String(widen ?? ""), /MELEBAR|PELANGGARAN/i);

    // parent restricted → child restriction hilang : DENY
    const vanished = run(undefined);
    assert.match(String(vanished ?? ""), /hilang|PELANGGARAN/i);

    // malformed (parent & child) : FAIL CLOSED
    assert.throws(
        () => agentHub.assertRestrictionsPreserved(
            { role: "system", capabilitySet: { acc: "*" } },
            { capabilitySet: ["memory_recall"] }),
        INVARIANT);
    assert.throws(
        () => agentHub.assertRestrictionsPreserved(
            { role: "system", capabilitySet: ["memory_recall"] },
            { capabilitySet: { acc: "*" } }),
        INVARIANT);

    // Dan mekanisme penerusnya (yang dipakai orchestrator plan/sintesis):
    const forwarded = Authorization.toCapabilitySet(PARENT);
    assert.deepEqual([...forwarded], PARENT);
});

// ---- 2. MATRIKS ADVERSARIAL ---------------------------------------------

test("M1-A: exec hilang → least privilege, bukan privileged+unrestricted", () => {

    assert.equal(resolveDelegator(null), null);
    assert.equal(resolveDelegator(undefined), null);

    const anon = identity({});
    assert.equal(anon.role, "user");
    assert.equal(anon.capabilitySet, undefined);
});

test("M1-B: role ada / capabilitySet absen → warisi peran, TANPA set fantasi", () => {

    const d = resolveDelegator({ role: "admin", sessionId: "s" });
    assert.equal(d.role, "admin");
    assert.equal(d.capabilitySet, undefined,
        "ketiadaan restriction legitimat tidak boleh diganti set karangan");
    assert.equal(hasRestriction(d.capabilitySet), false);
});

test("M1-C: capabilitySet ada / role hilang → restriction SELAMAT (carrier)", () => {

    const d = resolveDelegator({ capabilitySet: ["memory_recall"] });
    assert.ok(d, "delegasi restriction-only tidak boleh menjadi null");
    assert.deepEqual([...d.capabilitySet], ["memory_recall"]);
    assert.equal(d.role, undefined);

    // Efektif di gerbang: anggota set boleh, di luar set tetap DENY —
    // walau identitas roleless jatuh ke 'user'.
    const idc = identity(d);
    assert.doesNotThrow(() => assertExecution("memory_recall", idc));
    assert.throws(
        () => assertExecution("terminal_run", idc),
        e => e.code === "PERMISSION_DENIED"
    );

    // Versi narrowing bentuk lain juga selamat.
    const ds = resolveDelegator({ capabilitySet: "tool_search" });
    assert.deepEqual([...ds.capabilitySet], ["tool_search"]);
});

test("M1-D: identitas malformed → fail-closed di SEMUA gerbang", () => {

    for (const bad of [42, true, { acc: "*" }]) {
        assert.throws(() => identity({ capabilitySet: bad }), INVARIANT);
        assert.throws(() => toCapabilitySet(bad), INVARIANT);
        assert.throws(
            () => Authorization.disclosureFilter(
                [{ name: "memory_recall" }],
                { role: "superadmin", capabilitySet: bad }
            ),
            INVARIANT,
            "gerbang disklosur wajib menolak restriction tak dikenal"
        );
    }

    // exec non-object (mis. string hasil kerusakan serialisasi):
    assert.equal(identity("superadmin").role, "user",
        "exec primitif ≠ identitas; jatuh ke least privilege");
});

test("M1-E: bentuk caller legacy lewat batas runtime kanonik", () => {

    const { canonicalRequestExec } = require("../../src/ai/runtime/requestIdentity");

    const exec = canonicalRequestExec({
        messages: [{ role: "user", content: "x" }],
        role: "superadmin",
        capabilitySet: "tool_search"
    });

    assert.ok(exec, "identitas kanonik dibangun");
    assert.deepEqual([...exec.capabilitySet], ["tool_search"]);
    assert.equal(Object.isFrozen(exec.capabilitySet), true);

    // Malformed di level request juga gagal-keras sebelum gerbang mana pun.
    assert.throws(
        () => canonicalRequestExec({
            messages: [], role: "superadmin", capabilitySet: { acc: 1 }
        }),
        INVARIANT
    );

    // ---- M-1 rev4: jalur request.exec TIDAK lagi bypass kanonisasi ----
    const raw = { exec: { role: "superadmin", capabilitySet: ["memory_recall"] } };
    const canon = canonicalRequestExec(raw);

    assert.notEqual(canon, raw.exec, "identitas kanonik = salinan baru");
    assert.deepEqual([...canon.capabilitySet], ["memory_recall"]);
    assert.equal(Object.isFrozen(canon.capabilitySet), true,
        "restriction wajib dibekukan di tepi runtime");

    // Set programatik → frozen array (narrowing, bukan pelucutan).
    const fromSetExec = canonicalRequestExec({
        exec: { role: "admin", capabilitySet: new Set(["memory_recall"]) }
    });
    assert.deepEqual([...fromSetExec.capabilitySet], ["memory_recall"]);
    assert.equal(Object.isFrozen(fromSetExec.capabilitySet), true);

    // [] = PRESENT dan terkunci penuh — bukan "tanpa batas".
    const locked = canonicalRequestExec({
        exec: { role: "superadmin", capabilitySet: [] }
    });
    assert.deepEqual([...locked.capabilitySet], []);
    assert.equal(Object.isFrozen(locked.capabilitySet), true);
    assert.equal(hasRestriction(locked.capabilitySet), true);

    // Malformed di dalam exec → fail-closed.
    assert.throws(
        () => canonicalRequestExec({ exec: { role: "system", capabilitySet: { acc: "*" } } }),
        INVARIANT
    );

    // Idempoten — tanpa pelebaran ataupun kehilangan otoritas.
    const twice = canonicalRequestExec({ exec: canon });
    assert.deepEqual([...twice.capabilitySet], [...canon.capabilitySet]);
    assert.equal(twice.role, canon.role);
    assert.equal(Object.isFrozen(twice.capabilitySet), true);
    assert.equal(twice.sessionId ?? canon.sessionId, canon.sessionId ?? twice.sessionId);

    // Metadata eksekusi non-otoritas dipertahankan lewat kanonisasi.
    const meta = canonicalRequestExec({
        exec: {
            role: "admin", sessionId: "s-1", channel: "console",
            principalId: "p-1", workerId: "w-7", missionId: "m-9",
            capabilitySet: ["memory_recall"]
        }
    });
    assert.equal(meta.sessionId, "s-1");
    assert.equal(meta.channel, "console");
    assert.equal(meta.principalId, "p-1");
    assert.equal(meta.workerId, "w-7");
    assert.equal(meta.missionId, "m-9");

    // Provenance/grant kanonik (symbol) SELAMAT — kontrak N2 utuh.
    const grant = require("../../src/ai/tools/internalGrant")
        .mintCanonicalInternalGrant({ provenance: "watchdog:m1e" });
    const grantCanon = canonicalRequestExec({ exec: grant });
    assert.equal(isCanonicalInternalGrant(grantCanon), true,
        "INTERNAL_GRANT_TOKEN tidak boleh dicabut kanonisasi");
    assert.equal(grantCanon.source, grant.source);
});

test("M1-F: serialized/copied identity — restriction ikut, token tidak dipalsukan", () => {

    const grant = require("../../src/ai/tools/internalGrant")
        .mintCanonicalInternalGrant({ provenance: "watchdog:m1" });
    assert.equal(isCanonicalInternalGrant(grant), true);

    const throughJson = JSON.parse(JSON.stringify(grant));
    assert.equal(isCanonicalInternalGrant(throughJson),
        false, "symbol tidak bisa menyeberang serialisasi");

    // Salinan ber-restriction tetap DITEGAKKAN setelah bolak-balik JSON.
    const copied = JSON.parse(JSON.stringify({
        role: "admin",
        capabilitySet: [...Watchdog_SET()]
    }));
    assert.throws(
        () => assertExecution("terminal_run", copied),
        e => e.code === "PERMISSION_DENIED"
    );
    assert.doesNotThrow(() => assertExecution("memory_recall", copied));

    function Watchdog_SET() {
        return require("../../src/autonomy/watchdog").Watchdog
            .RECOVERY_CAPABILITIES;
    }
});

// ---- 3. NESTED CALLER: SelfHealing → ToolBus dengan bentuk baru ---------

const providerConfigService = require("../../src/services/providerConfigService");
providerConfigService.resolveActive = () => ({
    kind: "llamacpp", id: "llamacpp", label: "t", model: null,
    baseUrl: null, apiKey: null
});
const aiRuntime = require("../../src/services/aiRuntimeService");
aiRuntime.initialize();

const { ToolRegistry } = require("../../src/core/tools");
const executed = [];
ToolRegistry.register("m1Skills", {
    name: "probe",
    description: "Probe M-1.",
    parameters: {},
    execute: async () => { executed.push("m1Skills.probe"); return { ok: true }; }
});
aiRuntime.refreshTools();

test("M1-G: pemulihan nested dengan Set programatik — restriction ditegakkan", async () => {

    const healing = require("../../src/autonomy/SelfHealingEngine");
    executed.length = 0;

    // ANGGOTA set (bentuk Set — dulu DILUCUTI oleh Array.isArray gate):
    const okRun = await healing.recover({
        tool: "m1Skills__probe",
        args: {},
        error: new Error("ETIMEDOUT timeout"),
        goalId: "m1-ok",
        internal: true,
        capabilitySet: new Set(["m1Skills.probe"])
    });
    assert.equal(okRun.outcome.ok, true,
        "anggota set (bentuk Set) harus tereksekusi lewat bus");
    assert.ok(executed.includes("m1Skills.probe"));

    // Di luar set warisan yang sama: DENY — restriction benar-benar aktif.
    executed.length = 0;
    const denied = await healing.recover({
        tool: "m1Skills__probe",
        args: {},
        error: new Error("ETIMEDOUT timeout"),
        goalId: "m1-deny",
        internal: true,
        capabilitySet: new Set(["tool_search"])   // probe tidak termasuk
    });
    assert.equal(denied.outcome.ok, false);
    assert.match(String(denied.outcome.error ?? ""), /ditolak otorisasi|capability-set/i);
    assert.equal(executed.length, 0);
});

// ---- 3b. RESIDU PERSIS: batas fallback runtime (chatLocalFallback) ------

// Provider lokal diskriptakan agar jalur fallback deterministik offline.
class LocalScripted {
    constructor() { this.requests = []; }
    async chat(r) { this.requests.push(r); return { content: "lokal-m1", toolCalls: [], usage: {} }; }
    async *stream() {}
}
const engineM1 = aiRuntime.ensure();
const localProvider = new LocalScripted();
engineM1.registerProvider("llamacpp", localProvider);

test("M1-FALLBACK: parent [] TERKUNCI tidak lagi lolos penjaga (.length fail-open)", async () => {

    // CABANG PERSIS residu M-1: dulu `parentCapabilitySet.length`
    // mematikan penjaga untuk set kosong sehingga exec TANPA set
    // lolos ke engine sebagai superadmin unrestricted.
    await assert.rejects(
        () => aiRuntime.chatLocalFallback(
            {
                messages: [{ role: "user", content: "tugas" }],
                exec: { role: "superadmin", sessionId: "m1fb" },   // restriction HILANG
                parentCapabilitySet: []                            // terkunci penuh
            },
            "openai",
            { status: 429, message: "quota" }
        ),
        /hilang|PELANGGARAN/i
    );
    assert.equal(localProvider.requests.length, 0,
        "fallback tidak boleh mengeksekusi dengan restriction lenyap");
});

test("M1-FALLBACK-2: parent PRESENT + child hilang → DENY; bentuk sah → lewat", async () => {

    // Child hilang:
    await assert.rejects(
        () => aiRuntime.chatLocalFallback(
            {
                messages: [{ role: "user", content: "tugas" }],
                exec: { role: "superadmin", sessionId: "m1fb2" },
                parentCapabilitySet: ["memory_recall"]
            },
            "openai",
            { status: 429 }
        ),
        /hilang/i
    );

    // Parent Set programatik dinormalisasi — tidak dilucuti; child sama.
    const okSet = await aiRuntime.chatLocalFallback(
        {
            messages: [{ role: "user", content: "tugas" }],
            temperature: 0.2,
            tools: [],
            exec: {
                role: "superadmin", channel: "console", sessionId: "m1fb3",
                capabilitySet: ["memory_recall"]
            },
            parentCapabilitySet: new Set(["memory_recall"])
        },
        "openai",
        { status: 429 }
    );
    assert.ok(okSet, "fallback jalan dengan restriction ternormalisasi");
    const req0 = localProvider.requests.at(-1);
    assert.deepEqual([...req0.exec.capabilitySet], ["memory_recall"]);
    assert.equal(Object.isFrozen(req0.exec.capabilitySet), true);

    // Widen via fallback juga DENY.
    await assert.rejects(
        () => aiRuntime.chatLocalFallback(
            {
                messages: [{ role: "user", content: "tugas" }],
                exec: {
                    role: "superadmin", sessionId: "m1fb4",
                    capabilitySet: ["memory_recall", "terminal_run"]
                },
                parentCapabilitySet: "memory_recall"
            },
            "openai",
            { status: 429 }
        ),
        /MELEBAR/
    );

    // Tanpa restriction di kedua sisi: jalur legitimat tetap hidup.
    const plain = await aiRuntime.chatLocalFallback(
        {
            messages: [{ role: "user", content: "tugas" }],
            exec: { role: "user", sessionId: "m1fb5" },
            parentCapabilitySet: null
        },
        "openai",
        { status: 429 }
    );
    assert.ok(plain);
});

// ---- 4. PROPERTI PELESTARIAN --------------------------------------------

test("M1-H: properti — survive/narrow boleh, widen/vanish tidak pernah", () => {

    const cases = [
        // [parent, child, harapan: 'ok'|'throw']
        [["a", "b"], ["a", "b"], "ok"],           // survive
        [["a", "b"], ["a"], "ok"],                // narrow
        ["a", ["a"], "ok"],                       // narrow lintas bentuk
        [["a"], null, "throw"],                   // vanish
        [["a"], "b", "throw"],                    // vanish+ganti
        [["a"], ["a", "b"], "throw"],             // widen
    ];

    for (const [p, c, expect] of cases) {
        const parentExec = { role: "admin", capabilitySet: p };
        const childReq = c === null ? {} : { capabilitySet: c };
        const agentHub = require("../../src/services/agentHub");
        if (expect === "ok") {
            assert.doesNotThrow(
                () => agentHub.assertRestrictionsPreserved(parentExec, childReq),
                `parent=${JSON.stringify(p)} child=${JSON.stringify(c)}`
            );
        } else {
            assert.throws(
                () => agentHub.assertRestrictionsPreserved(parentExec, childReq),
                `parent=${JSON.stringify(p)} child=${JSON.stringify(c)}`
            );
        }
    }

    // INVARIANT GLOBAL: tak ada satupun jalur di atas yang menghasilkan
    // delegasi privileged TANPA restriction ketika parent membawa one.
    for (const p of [["a"], "a", new Set(["a"]), { junk: 1 }, 7]) {
        let outcome = null;
        try {
            outcome = resolveDelegator({ role: "superadmin", capabilitySet: p });
        }
        catch { /* fail-closed adalah outcome yang sah */ }
        if (outcome) {
            const privileged =
                outcome.role === "system" || outcome.role === "superadmin";
            assert.equal(
                privileged && !hasRestriction(outcome.capabilitySet),
                false,
                `parent=${String(p)} → privileged tanpa restriction TERLARANG`
            );
        }
    }
});
