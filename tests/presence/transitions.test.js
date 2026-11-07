const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, CAUSE, HEALTH
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence transitions runtime — fail closed & atomik (P3, P5)", () => {
    it("jalur boot lengkap: BOOTING>INITIALIZING>DORMANT dengan jurnal berurutan", () => {
        const { rt, host } = createBootedRuntime();
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
        const journal = rt.getJournal();
        const causes = journal.filter((e) => e.from !== e.to).map((e) => e.cause);
        assert.deepEqual(causes, [
            CAUSE.PROCESS_START,
            CAUSE.INITIALIZATION_STARTED,
            CAUSE.INITIALIZATION_COMPLETE
        ]);
        assert.ok(host.id);
    });

    it("transisi ilegal ditolak tanpa mengubah state byte-per-byte", () => {
        const { rt, host } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.requestTransition({ to: LIFECYCLE.ACTIVE, cause: CAUSE.ACTIVITY_STARTED, producer: host });
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_INVALID_TRANSITION");
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("sebab yang salah untuk edge sah ditolak (INVALID_CAUSE), state utuh", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host, "ok");
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.requestTransition({
            to: LIFECYCLE.SHUTTING_DOWN,
            cause: CAUSE.USER_SUMMON,
            producer: host
        });
        assert.equal(result.code, "REJECTED_INVALID_CAUSE");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("target tak dikenal ditolak (UNKNOWN_TARGET)", () => {
        const { rt, host } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.requestTransition({ to: "OMNISCIENT", cause: CAUSE.USER_SUMMON, producer: host });
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_UNKNOWN_TARGET");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("FAILED terminal: semua mutasi lanjutan ditolak", () => {
        const { rt, host, interaction } = createBootedRuntime();
        rt.reportFatalFailure(host, "disk penuh");
        assert.equal(rt.lifecycleState, LIFECYCLE.FAILED);
        for (const attempt of [
            () => rt.summon(interaction),
            () => rt.beginActivity("THINKING"),
            () => rt.markInitializationComplete(),
            () => rt.requestShutdown(host)
        ]) {
            const before = JSON.stringify(rt.getPresenceStatus());
            const result = attempt();
            assert.equal(result.ok, false, `${result} harus gagal di FAILED`);
            assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
        }
    });

    it("shutdown dua tahap: alive>SHUTTING_DOWN>OFFLINE; OFFLINE menolak summon", () => {
        const { rt, host, interaction } = createBootedRuntime();
        assert.equal(rt.requestShutdown(host, "SIGTERM").code, "OK_COMMITTED");
        assert.equal(rt.lifecycleState, LIFECYCLE.SHUTTING_DOWN);
        assert.equal(rt.confirmOffline().code, "OK_COMMITTED");
        assert.equal(rt.lifecycleState, LIFECYCLE.OFFLINE);
        const r = rt.summon(interaction);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_INVALID_TRANSITION");
    });

    it("health UNKNOWN saat pra-boot, HEALTHY saat DORMANT (P13: DORMANT+HEALTHY valid)", () => {
        const clock = require("../../src/runtime/presence").createManualClock(7);
        const raw = require("../../src/runtime/presence").createPresenceRuntime({ clock });
        assert.equal(raw.getPresenceStatus().health, HEALTH.UNKNOWN);
        const { rt } = createBootedRuntime({ startMs: 7, config: {} });
        assert.equal(rt.getPresenceStatus().health, HEALTH.HEALTHY);
    });

    it("subscriber yang melempar tidak membatalkan transisi yang sudah commit", () => {
        const { rt, host } = createBootedRuntime();
        let seen = 0;
        rt.subscribe(() => {
            seen += 1;
            throw new Error("visual client rusak");
        });
        const result = rt.summon(host);
        assert.equal(result.ok, true, "transisi committed tetap sukses");
        assert.equal(rt.lifecycleState, LIFECYCLE.AWAKE);
        assert.equal(seen, 1);
        const status = rt.getPresenceStatus();
        assert.ok(rt.getCounters().subscriberErrorsIsolated >= 1);
    });

    it("jurnal immutable/detached: memutasi snapshot tidak merusak runtime", () => {
        const { rt } = createBootedRuntime();
        const snap = rt.getJournal();
        snap[0].cause = "DIPALSUKAN";
        snap.push({ fake: true });
        const fresh = rt.getJournal();
        assert.notEqual(fresh.length, snap.length);
        assert.equal(fresh[0].cause, "GENERATION_ADVANCED");
    });

    it("entri jurnal punya field kanon lengkap dan timestamp numerik", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const entries = rt.getJournal();
        const last = entries[entries.length - 1];
        for (const key of ["sequence", "generation", "from", "to", "activity",
            "cause", "producerId", "timestampMs", "reason"]) {
            assert.ok(key in last, `field ${key} wajib ada`);
        }
        assert.equal(typeof last.timestampMs, "number");
        assert.equal(typeof last.sequence, "number");
    });

    it("lastTransition di status mencerminkan transisi terakhir", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const status = rt.getPresenceStatus();
        assert.deepEqual(
            [status.lastTransition.from, status.lastTransition.to],
            [LIFECYCLE.DORMANT, LIFECYCLE.AWAKE]
        );
    });

    it("summon idempoten saat sudah bangun; dismiss dari DORMANT noop", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const again = rt.summon(host);
        assert.equal(again.ok, true);
        assert.equal(again.code, "OK_NOOP");
        rt.dismiss(host);
        const dismissedAgain = rt.dismiss(host);
        assert.equal(dismissedAgain.ok, true);
        assert.equal(dismissedAgain.code, "OK_NOOP");
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
    });

    it("dismiss TIDAK mematikan runtime — DORMANT tetap hidup, bisa disummon lagi", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        rt.dismiss(host);
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
        assert.equal(rt.getPresenceStatus().summoned, false);
        assert.equal(rt.getPresenceStatus().uptimeMs !== null, true, "runtime masih hidup");
        rt.summon(host);
        assert.equal(rt.lifecycleState, LIFECYCLE.AWAKE);
    });

    it("transisi dari produsen tak dikenal ditolak sebelum validasi graf", () => {
        const { rt } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const r1 = rt.requestTransition({ to: LIFECYCLE.AWAKE, cause: CAUSE.USER_SUMMON, producer: null });
        const r2 = rt.requestTransition({
            to: LIFECYCLE.AWAKE, cause: CAUSE.USER_SUMMON,
            producer: { id: "producer:host:1", kind: "HOST" }
        });
        assert.equal(r1.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(r2.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });
});
