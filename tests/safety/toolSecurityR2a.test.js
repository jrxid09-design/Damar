const test = require("node:test");
const assert = require("node:assert");

const Authorization = require("../../src/ai/tools/Authorization");
const bus = require("../../src/autonomy/ToolBus");
const loopGuard = require("../../src/core/safety/loopGuard");
const RuntimeExecutor = require("../../src/ai/executors/RuntimeExecutor");
const AIToolCall = require("../../src/ai/tools/AIToolCall");

/** ROUND-2 SEAMS A — C1 tunnel, C2 console, stream parity, dedupe. */

const call = (n, a) => new AIToolCall({
    id: `r2-${Math.random().toString(36).slice(2, 7)}`, name: n, arguments: a
});

function executorWith(map, execDefaults = { role: "superadmin", channel: "test" }) {
    const ex = new RuntimeExecutor(
        { chat: async () => ({ content: "done", toolCalls: [] }) },
        { callTimeout: 5000 }
    );
    ex.setToolRegistry({ map, get(n) { return this.map.get(n); } });
    const o = ex.execute.bind(ex);
    ex.execute = (r) => o({ exec: r.exec ?? execDefaults, ...r });
    const os = ex.stream.bind(ex);
    ex.stream = async function* (r) {
        yield* os({ exec: r.exec ?? execDefaults, ...r });
    };
    return ex;
}

// ---- C1 -----------------------------------------------------------------

test("C1a. admin→terminal_run langsung DENY", () => {
    assert.throws(() =>
        Authorization.assertExecution("terminal_run",
            Authorization.identity({ role: "admin", channel: "telegram" })),
    e => e.code === "PERMISSION_DENIED");
});

test("C1b. admin→tool_exec(wrapper)→terminal_run DENY (tunnel tertutup)", async () => {

    const saved = bus.resolve;
    bus.resolve = () => ({
        kind: "ai",
        tool: { name: "terminal_run", description: "run", parameters: {}, execute: async () => ({ ran: true }) },
        execute: async () => ({ ran: true })
    });

    try {
        const r = await bus.execute({
            name: "terminal_run", args: {},
            context: { exec: { role: "admin", channel: "telegram" } }
        });
        assert.equal(r.ok, false);
        assert.match(String(r.error), /PERMISSION_DENIED|tidak diizinkan/i);
    }
    finally { bus.resolve = saved; }

});

test("C1c. tanpa identitas → DENY (bukan system)", async () => {

    const saved = bus.resolve;
    bus.resolve = () => ({
        kind: "ai",
        tool: { name: "create_tool", description: "x", parameters: {}, execute: async () => ({}) },
        execute: async () => ({})
    });

    try {
        const r = await bus.execute({ name: "create_tool", args: {} });
        assert.equal(r.ok, false);
    }
    finally { bus.resolve = saved; }

});

test("C1d. internal system eksplisit tetap sah (GoalEngine path)", async () => {
    const saved = bus.resolve;
    bus.resolve = () => ({
        kind: "ai",
        tool: { name: "memory_recall", description: "recall memories", parameters: {}, execute: async () => ({}) },
        execute: async () => ({})
    });
    try {
        const r = await bus.execute({
            name: "memory_recall", args: {},
            context: { exec: { role: "system", channel: "autonomy", sessionId: "goal-1" } }
        });
        assert.equal(r.ok, true);
    }
    finally { bus.resolve = saved; }
});

// ---- C2 ------------------------------------------------------------------

test("C2. console guard: unset/empty→503, wrong→401, valid→provenance superadmin", () => {

    delete process.env.DAMAR_TOKEN;
    const { tokenGuard } = require("../../src/core/auth/tokenCompare");

    const resLike = () => {
        const res = { statusCode: null };
        res.status = c => { res.statusCode = c; return res; };
        res.json = b => { res.body = b; return res; };
        return res;
    };

    const guard = tokenGuard({ roleWhenAuthenticated: "superadmin", surface: "console" });

    // unset
    delete process.env.DAMAR_TOKEN;
    let res = resLike(), next = false;
    guard({ method: "POST", headers: { host: "10.0.0.5:3000" }, ip: "10.0.0.5" }, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 503);

    // empty string
    process.env.DAMAR_TOKEN = "";
    res = resLike(); next = false;
    guard({ method: "POST", headers: { host: "x" } }, res, () => { next = true; });
    assert.equal(res.statusCode, 503);

    // wrong
    process.env.DAMAR_TOKEN = "rahasia";
    res = resLike(); next = false;
    guard({ method: "POST", headers: { authorization: "Bearer salah" } }, res, () => { next = true; });
    assert.equal(res.statusCode, 401);

    // valid
    res = resLike(); next = false;
    const req = { method: "POST", headers: { authorization: "Bearer rahasia" }, ip: "1.1.1.1" };
    guard(req, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(req.authIdentity.role, "superadmin");
    assert.match(req.authIdentity.source, /token:console/);

    delete process.env.DAMAR_TOKEN;

});

// ---- N1: lokalitas dari socket, bukan Host ---------------------------------

test("N1. dev-open: Host: localhost dari remote TIDAK mendapat superadmin", () => {

    delete process.env.DAMAR_TOKEN;
    process.env.DAMAR_UNSAFE_DEV_OPEN_API = "1";
    process.env.DAMAR_UNSAFE_DEV_ROLE = "superadmin";

    try {
        const { tokenGuard } = require("../../src/core/auth/tokenCompare");
        const guard = tokenGuard({ surface: "api" });

        const resLike = () => {
            const res = { statusCode: null };
            res.status = c => { res.statusCode = c; return res; };
            res.json = b => { res.body = b; return res; };
            return res;
        };

        // Spoof: klien LAN memalsuk Host: localhost.
        const spoof = { method: "POST", headers: { host: "localhost:3000" }, ip: "192.168.1.66" };
        let res = resLike(), next = false;
        guard(spoof, res, () => { next = true; });
        assert.equal(next, true);
        assert.equal(spoof.authIdentity.role, "user",
            "Host dipalsukan TIDAK boleh menaikkan peran");

        // Lokal sungguhan (socket) tetap dapat peran dev.
        const local = { method: "POST", headers: { host: "evil.example" }, ip: "127.0.0.1" };
        guard(local, resLike(), () => {});
        assert.equal(local.authIdentity.role, "superadmin",
            "loopback asli tetap dapat DAMAR_UNSAFE_DEV_ROLE");

        const v6 = { method: "POST", headers: {}, ip: "::1" };
        guard(v6, resLike(), () => {});
        assert.equal(v6.authIdentity.role, "superadmin");

        const mapped = { method: "POST", headers: {}, ip: "::ffff:127.0.0.1" };
        guard(mapped, resLike(), () => {});
        assert.equal(mapped.authIdentity.role, "superadmin");

        // Tanpa alamat sama sekali → fail-closed sebagai user.
        const unknown = { method: "POST", headers: { host: "localhost" }, ip: undefined };
        guard(unknown, resLike(), () => {});
        assert.equal(unknown.authIdentity.role, "user");
    }
    finally {
        delete process.env.DAMAR_UNSAFE_DEV_OPEN_API;
        delete process.env.DAMAR_UNSAFE_DEV_ROLE;
    }

});

// ---- H1 parity ------------------------------------------------------------

test("H1. stream & non-stream identitas eksekusi identik", async () => {

    const seen = [];
    const map = new Map([
        ["probe", { name: "probe", description: "probe", parameters: {}, execute: async () => ({ ok: 1 }) }]
    ]);

    const ex = executorWith(map);

    const origExec = ex.toolExecutor.execute.bind(ex.toolExecutor);
    ex.toolExecutor.execute = (c, e) => { seen.push(e?.role); return origExec(c, e); };

    let giliran = 0;
    ex.service = {
        chat: async () => {
            giliran += 1;
            return giliran === 1
                ? { content: "", toolCalls: [call("probe", {})] }
                : { content: "selesai", toolCalls: [] };
        },
        stream: async function* () {
            // Round-aware: toolCalls HANYA pada putaran pertama —
            // mengonsumsi ulang generator tidak boleh memunculkan
            // panggilan identik lagi (cycle-detector bekerja benar).
            if (giliran === 1) {
                yield { delta: "", toolCalls: [call("probe", {})], finishReason: "tool_calls" };
                yield { delta: "ok", finishReason: "stop", done: true };
            }
        }
    };

    await ex.execute({ messages: [{ role: "user", content: "a" }] });
    for await (const _ of ex.stream({ messages: [{ role: "user", content: "b" }] })) { void _; }

    assert.deepEqual([...new Set(seen)], ["superadmin"]);

});

// ---- H4/H5 -------------------------------------------------------------------

test("H4. reset(scope) terisolasi lintas sesi", () => {

    loopGuard.reset("r2A");
    loopGuard.reset("r2B");

    for (let i = 0; i < 4; i++) loopGuard.assertNotLooping("t.q", { a: 1 }, "r2A");

    assert.throws(() => loopGuard.assertNotLooping("t.q", { a: 1 }, "r2A"));
    assert.doesNotThrow(() => loopGuard.assertNotLooping("t.q", { a: 1 }, "r2B"));

    loopGuard.reset("r2A");
    loopGuard.reset("r2B");

});

test("H5. dedupe: sukses identik terdedupe; kegagalan tetap utuh ber-status", () => {

    const ex = executorWith(new Map());

    const body = { ok: true, data: "STATUS: semua sistem normal dan berjalan sangat baik hari ini" };

    const req = { messages: [], __obsFingerprints: new Map() };

    ex.boundContent({ name: "t", result: body }, req);

    const dup = ex.boundContent({ name: "t", result: body }, req);

    assert.match(dup, /deduped/);
    assert.match(dup, /status/);

    const failed = ex.boundContent({
        name: "t",
        result: { error: { code: "EXECUTION_ERROR", message: body.data } }
    }, req);

    assert.ok(!/deduped/.test(failed));
    assert.match(failed, /EXECUTION_ERROR/);

});
