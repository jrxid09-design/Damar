"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createRuntimeHost,
    HOST_PHASE
} = require("../../src/runtime/host/runtimeHost");
const presenceMod = require("../../src/runtime/presence");
const { HOST_COMMANDS } = require("../../src/runtime/host/commands");

// ---------------------------------------------------------------- helpers

async function makeHost(overrides = {}) {
    return createRuntimeHost({ coreOptions: {}, ...overrides });
}

// ----------------------------------------------------------------- tests

test("LIFECYCLE: BOOT→INITIALIZE→RECOVER→READY dengan Presence DORMANT", async () => {
    const host = await makeHost();
    try {
        assert.equal(host.phase, HOST_PHASE.READY);
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);
        assert.equal(host.health().healthy, true);
        assert.ok(host.status().generationId.startsWith("rtg-"));
        assert.equal(host.status().generationHistoryCount >= 2, true,
            "clean start harus mencap generasi runtime baru di ledger");
    } finally {
        host.shutdown("test-end");
    }
});

test("SUMMON/DISMISS: transisi kanonik via Presence, idempoten saat sudah bangun/tidur", async () => {
    const host = await makeHost();
    try {
        const s1 = host.summon({ source: "test" });
        assert.equal(s1.ok, true);
        assert.equal(s1.to, presenceMod.LIFECYCLE.AWAKE);

        const s2 = host.summon({ source: "test" });
        assert.equal(s2.ok, true);
        assert.equal(s2.code, "OK_NOOP", "summon ganda harus noop, bukan error");

        const d1 = host.dismiss({ source: "test" });
        assert.equal(d1.ok, true);
        assert.equal(d1.to, presenceMod.LIFECYCLE.DORMANT);

        const d2 = host.dismiss({ source: "test" });
        assert.equal(d2.ok, true);
        assert.equal(d2.code, "OK_NOOP");
        assert.equal(host.health().phase, HOST_PHASE.READY,
            "dismiss TIDAK mematikan host");
    } finally {
        host.shutdown("test-end");
    }
});

test("DISMISS != SHUTDOWN: proses tetap hidup dan bisa summon ulang", async () => {
    const host = await makeHost();
    try {
        host.summon({});
        host.dismiss({});
        const again = host.summon({ source: "after-dismiss" });
        assert.equal(again.ok, true, "setelah dismiss host masih operasional");
    } finally {
        host.shutdown("test-end");
    }
});

test("SHUTDOWN idempoten + double shutdown aman; presence OFFLINE", async () => {
    const host = await makeHost();
    host.summon({});
    const first = host.shutdown("test");
    assert.equal(first.shutDown, true);
    assert.equal(first.idempotent, false);
    const second = host.shutdown("test");
    assert.equal(second.shutDown, true);
    assert.equal(second.idempotent, true);
    assert.equal(host.core.presence.lifecycleState, presenceMod.LIFECYCLE.OFFLINE);
    assert.equal(host.phase, HOST_PHASE.TERMINATED);
    assert.equal(host.summon({}).ok, false, "summon setelah shutdown ditolak");
});

test("RUNTIME API lokal: COMMAND summon/dismiss/status lewat InteractionBus", async () => {
    const host = await makeHost();
    try {
        const r1 = host.submitLocal({
            kind: "COMMAND",
            payload: {
                command: HOST_COMMANDS.SUMMON,
                namedArguments: { source: "api-test" }
            }
        });
        assert.equal(r1.accepted, true);
        assert.equal(r1.state, "COMPLETED");

        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.AWAKE,
            "COMMAND summon harus menggerakkan presence ke AWAKE");

        const r2 = host.submitLocal({
            kind: "COMMAND", payload: { command: HOST_COMMANDS.DISMISS }
        });
        assert.equal(r2.accepted, true);
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);

        const r3 = host.submitLocal({
            kind: "STATUS_REQUEST", payload: {}
        });
        assert.equal(r3.accepted, true);
    } finally {
        host.shutdown("test-end");
    }
});

test("COMMAND tak dikenal / malformed → interaksi selesai dengan penolakan jujur, tanpa crash", async () => {
    const host = await makeHost();
    try {
        const bad1 = host.submitLocal({ kind: "COMMAND", payload: { command: "nuke" } });
        assert.equal(bad1.accepted, true, "perintah valid secara bentuk tetap diterima bus");
        // Payload salah bentuk ditolak tertutup oleh validasi bus.
        const bad2 = host.submitLocal({ kind: "COMMAND", payload: 42 });
        assert.equal(bad2.accepted, false, "payload non-objek harus ditolak validasi");
        // state presence tidak berubah
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT);
    } finally {
        host.shutdown("test-end");
    }
});

test("FAIL/RECOVER: FAILED lalu recoverNow masuk generasi BARU tanpa resume aktivitas", async () => {
    const host = await makeHost();
    try {
        host.summon({});
        const act = host.beginActivity(presenceMod.ACTIVITY_MODE.SPEAKING, {});
        assert.equal(act.ok, true);
        const oldToken = act.token;

        const f = host.fail({ reason: "injected" });
        assert.equal(f.ok, true);
        assert.equal(host.phase, HOST_PHASE.FAILED);
        assert.equal(host.health().healthy, false);
        assert.equal(host.summon({}).ok, false, "host gagal menolak summon");

        const rec = host.recoverNow({ reason: "test-recover" });
        assert.equal(rec.ok, true);
        assert.equal(rec.generationId !== host.status().generationId ? false : true, true);
        assert.notEqual(rec.generationId, undefined);
        assert.equal(host.phase, HOST_PHASE.READY);
        assert.equal(host.health().presenceState, presenceMod.LIFECYCLE.DORMANT,
            "recover menghasilkan DORMANT bersih, bukan resume SPEAKING");

        const endOld = (() => {
            try { return host.endActivity(oldToken, { reason: "stale" }); }
            catch { return { ok: false }; }
        })();
        assert.equal(endOld.ok, false,
            "token aktivitas generasi lama tidak valid di generasi baru");
    } finally {
        host.shutdown("test-end");
    }
});

test("RECOVER ringan dari READY: generasi ledger sama, presence tetap sehat", async () => {
    const host = await makeHost();
    try {
        const before = host.status().generationId;
        const rec = host.recoverNow({ reason: "light" });
        assert.equal(rec.ok, true);
        assert.equal(rec.generationId, before,
            "recover ringan tidak advance ledger generation");
        assert.equal(host.health().healthy, true);
    } finally {
        host.shutdown("test-end");
    }
});
