"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const { createChannelBridge } = require("../../src/runtime/host/channelBridge");
const { EventEmitter } = require("node:events");
const presenceMod = require("../../src/runtime/presence");

// ---------------------------------------------------------------- helpers

async function makeHost(extra = {}) {
    return createRuntimeHost({ coreOptions: {}, ...extra });
}

function terminalSnapshot(host) {
    return {
        phase: host.phase,
        generationId: host.status().generationId,
        shuttingDown: host.status().shuttingDown
    };
}

// ------------------------------------------------------- failure injection

test("FAIL: transport failure — disconnect bus + ingest setelahnya bersih", async () => {
    const host = await makeHost();
    try {
        const att = host.attachTransportAdapter({ transportId: "f.transport", origin: "API" });
        assert.equal(att.adapter.ingestExternalEvent({ text: "ok" }).accepted, true);

        // Simulasi transport gagal dari sisi bus.
        host.core.bus.transportDisconnect("f.transport");
        const r = att.adapter.ingestExternalEvent({ text: "setelah putus" });
        // Adapter belum tahu; bus yang menolak/menoleransi — tidak boleh crash.
        assert.equal(typeof r.accepted, "boolean");
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: Presence subscriber fault tidak menghambat lifecycle host", async () => {
    const host = await makeHost();
    try {
        let calls = 0;
        host.core.presence.subscribe(() => {
            calls += 1;
            throw new Error("subscriber rusak");
        });
        const s = host.summon({});
        assert.equal(s.ok, true, "summon tetap sukses meski subscriber lempar");
        const d = host.dismiss({});
        assert.equal(d.ok, true);
        assert.ok(calls >= 2);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: recovery failure — failRecovery menghasilkan FAILED lalu recoverNow pulih", async () => {
    const host = await makeHost();
    try {
        // Paksa presence ke RECOVERING lalu gagalkan (jalur kanonik).
        const rt = host.core.presence;
        rt.requestRecovery(host.core.presenceProducers.recovery, "injected");
        rt.failRecovery(host.core.presenceProducers.recovery, "injected-failure");
        assert.equal(rt.lifecycleState, presenceMod.LIFECYCLE.FAILED);

        const rec = host.recoverNow({ reason: "after-presence-recovery-failure" });
        assert.equal(rec.ok, true);
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: Governor pressure UNKNOWN → representasi degradasi, bukan crash/permission", async () => {
    // Observer mati → governor melapor pressureBand UNKNOWN (fail-closed),
    // host tetap hidup; pressure != permission.
    const governorFactory = require("../../src/runtime/resourceGovernor");
    const gov = governorFactory.createResourceGovernor({
        observer: { observe() { throw new Error("observer offline"); } }
    });
    const host = await createRuntimeHost({
        coreOptions: { governor: gov }
    });
    try {
        assert.equal(host.health().pressureBand, "UNKNOWN");
        assert.equal(host.health().healthy, true,
            "pressure UNKNOWN tidak menjatuhkan host");
        // Summon/dismiss tetap berfungsi — pressure bukan permission.
        assert.equal(host.summon({}).ok, true);
        assert.equal(host.dismiss({}).ok, true);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: duplicate summon/dismiss & double shutdown — tanpa korupsi state", async () => {
    const host = await makeHost();
    try {
        for (let i = 0; i < 5; i++) host.summon({});
        for (let i = 0; i < 5; i++) host.dismiss({});
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);

        host.shutdown("first");
        const snapBefore = terminalSnapshot(host);
        host.shutdown("second");
        assert.deepEqual(terminalSnapshot(host), snapBefore,
            "status terminal stabil setelah shutdown ganda");
    } finally {
        void host;
    }
});

test("FAIL: malformed interactions storm — bus menolak, host tetap sehat", async () => {
    const host = await makeHost();
    try {
        const att = host.attachTransportAdapter({ transportId: "f.mal", origin: "API" });
        const garbage = [null, undefined, 42, "str", [], {}, { text: 1 },
            { text: null }, { userId: 5 }, { text: "x".repeat(100000) }];
        for (const g of garbage) {
            try { att.adapter.ingestExternalEvent(g); } catch { /* tidak boleh */ }
        }
        assert.equal(att.adapter.snapshot().counters.accepted <= 1, true);
        assert.equal(host.health().healthy, true);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: bridge listener exception tidak menjatuhkan emitter sumber", async () => {
    const host = await makeHost();
    try {
        const emitter = new EventEmitter();
        const bridge = createChannelBridge({ bus: host.core.bus, channels: ["telegram"] });
        bridge.attachEmitter(emitter);
        // Event ekstrem
        emitter.emit("telegram:message", { chatId: Symbol("x") });
        emitter.emit("telegram:message", { chatId: {}, preview: {} });
        assert.equal(host.health().healthy, true);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL: interupsi runtime saat WAITING_FOR_OWNER — dismiss legal, approval tidak otomatis", async () => {
    const host = await makeHost();
    try {
        host.summon({});
        host.core.presence.beginOwnerWait({
            producer: host.core.presenceProducers.host
        });
        assert.equal(host.health().presenceState, "WAITING_FOR_OWNER");

        const d = host.dismiss({});
        assert.equal(d.ok, true, "dismiss dari WAITING_FOR_OWNER legal");
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);

        // Tidak ada approval yang tercatat di mana pun:
        const registry = host.core.wave1.authority.registry;
        assert.equal((await registry.authorize({
            capabilityId: "owner.wait.implicit.approval", action: "use"
        })).allowed, false);
    } finally {
        host.shutdown("test-end");
    }
});
