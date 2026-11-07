const test = require("node:test");
const assert = require("node:assert");

/**
 * ACC WORKSPACE (§26–§28/§105) — determinisme, boundedness, habituation,
 * TTL, anti-starvation.
 */

const acc = require("../../src/cognition");
const { createMemoryAccStore } = require("../../src/cognition/persistence/AccStore");

const T0 = 1_000_000;

function makeCore() {
    return new acc.ContinuityCore({
        store: createMemoryAccStore(),
        clock: acc.manualClock(T0),
        config: acc.createACCConfig({ DAMAR_ACC: "shadow" })
    });
}

function toolEvent(i, type = "TOOL_FAILED", surpriseHint = undefined) {
    return acc.envelope.makeEnvelope({
        type, source: "t", provenance: "OBSERVATION",
        subject: `tool-${i}`,
        payload: surpriseHint !== undefined
            ? { tool: `t${i}`, expectedFailure: surpriseHint } : { tool: `t${i}` },
        clock: { nowMs: () => T0 }
    });
}

test("C0.4: urutan event sama → workspace identik (replay-stable)", async () => {

    const seq = Array.from({ length: 12 }, (_, i) =>
        i % 3 === 0 ? toolEvent(i, "TOOL_FAILED") : toolEvent(i, "TOOL_SUCCEEDED"));

    const a = await makeCore().initialize();
    for (const e of seq) await a.feed(e);

    const b = await makeCore().initialize();
    for (const e of seq) await b.feed(e);

    const keysA = a.state.workspace.items.map(i => `${i.key}:${i.salience}`);
    const keysB = b.state.workspace.items.map(i => `${i.key}:${i.salience}`);

    assert.deepEqual(keysB, keysA);
});

test("C0.4: WORKSPACE STORM — ribuan event low-value tetap bounded; yang penting menang (§105)", async () => {

    const c = await makeCore().initialize();

    // 5000 event sepele sukses (salience rendah).
    for (let i = 0; i < 5000; i++) {
        await c.feed(toolEvent(10000 + i, "TOOL_SUCCEEDED"));
    }

    // Satu kegagalan alat SANGAT andal → surpris tinggi.
    await c.feed(acc.envelope.makeEnvelope({
        type: "TOOL_FAILED", source: "t", provenance: "OBSERVATION",
        subject: "critical-failure", payload: { tool: "auth-core" },
        clock: { nowMs: () => T0 }
    }));

    const ws = c.state.workspace;
    assert.ok(ws.items.length <= c.config.workspace.capacity,
        `kapasitas dilanggar: ${ws.items.length}`);

    const topKey = ws.items[0]?.key ?? "";
    assert.match(topKey, /TOOL_FAILED:critical-failure/,
        "event salience tertinggi wajib memenangkan kompetisi");
});

test("C0.4: habituation — pengulangan menurunkan daya saing", async () => {

    const c = await makeCore().initialize();

    // Enam kegagalan ALAT YANG SAMA → kandidat key sama berulang.
    for (let i = 0; i < 6; i++) {
        await c.feed(acc.envelope.makeEnvelope({
            type: "TOOL_FAILED", source: "t", provenance: "OBSERVATION",
            subject: "sama", payload: { tool: "browse", expectedFailure: true },
            clock: { nowMs: () => T0 }
        }));
    }

    // Kandidat baru setara harus bisa menggeser item yang jenuh.
    const before = c.state.workspace.items.find(i => i.key.includes(":sama"));
    await c.feed(acc.envelope.makeEnvelope({
        type: "PROVIDER_DEGRADED", source: "t", provenance: "SYSTEM_EVENT",
        subject: "provider-baru", payload: { surprise: 0.7 },
        clock: { nowMs: () => T0 }
    }));

    const after = c.state.workspace.items.find(i => i.key.includes(":sama"));
    if (after && before) {
        assert.ok(after.salience <= before.salience + 1e-9,
            "repetisi tidak boleh menaikkan salience");
    }
    assert.ok(c.state.workspace.habituation["TOOL_FAILED:sama"] > 0,
        "habituation tercatat");
});

test("C0.4: TTL mengeluarkan entri kadaluarsa (sweep)", () => {

    let W = acc.Workspace.emptyWorkspace();
    const cfg = acc.createACCConfig({});
    const now = T0;

    W = acc.Workspace.admit(W, {
        key: "lama", novelty: 1, urgency: 1, goalRelevance: 1,
        createdAtMs: now - cfg.workspace.ttlMs - 1
    }, cfg, now);
    W = acc.Workspace.admit(W, {
        key: "baru", novelty: 0.2, createdAtMs: now
    }, cfg, now);

    W = acc.Workspace.sweep(W, cfg, now);

    assert.equal(W.items.length, 1);
    assert.equal(W.items[0].key, "baru");
});
