const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, CAUSE, ACTIVITY_MODE
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence activities — token autentik (P7)", () => {
    it("beginActivity mengembalikan token opaque terikat mode+generasi", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const { ok, code, token } = rt.beginActivity(ACTIVITY_MODE.THINKING);
        assert.equal(ok, true);
        assert.equal(code, "OK_COMMITTED");
        assert.match(token.id, /^activity:\d{6}$/);
        assert.equal(token.mode, "THINKING");
        assert.equal(token.generation, rt.generation);
    });

    it("AWAKE dipromosikan ke ACTIVE oleh beginActivity (ACTIVITY_STARTED)", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("ATTENDING");
        assert.equal(rt.lifecycleState, LIFECYCLE.ACTIVE);
    });

    it("beginActivity dari DORMANT ditolak — tanpa summon tidak ada aktivitas", () => {
        const { rt } = createBootedRuntime();
        const r = rt.beginActivity("THINKING");
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_INVALID_STATE");
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
    });

    it("mode IDLE tak bisa dimulai manual; mode asal ditolak", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        assert.equal(rt.beginActivity("IDLE").code, "REJECTED_INVALID_ACTIVITY_MODE");
        assert.equal(rt.beginActivity("MEDITATING").code, "REJECTED_INVALID_ACTIVITY_MODE");
    });

    it("token palsu (plain object) ditolak FORGED_TOKEN + counter naik", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const before = JSON.stringify(rt.getPresenceStatus());
        const beforeCounters = rt.getCounters().forgedTokensRejected;
        const forged = { id: "activity:000001", mode: "THINKING", generation: rt.generation };
        const r = rt.endActivity(forged);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_FORGED_TOKEN");
        assert.equal(rt.getCounters().forgedTokensRejected, beforeCounters + 1);
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before, "state murni tetap utuh");
    });

    it("double completion idempoten: OK_ALREADY_COMPLETED tanpa mutasi", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("THINKING");
        assert.equal(rt.endActivity(token).ok, true);
        const before = JSON.stringify(rt.getPresenceStatus());
        const second = rt.endActivity(token);
        assert.equal(second.ok, true);
        assert.equal(second.code, "OK_ALREADY_COMPLETED");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("aktivitas kedaluwarsa tidak bisa dihidupkan ulang (EXPIRED_TOKEN)", () => {
        const { rt, host, clock } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("THINKING", { ttlMs: 100 });
        clock.advanceMs(101);
        rt.getPresenceStatus(); // sweep
        const r = rt.endActivity(token);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_EXPIRED_TOKEN");
    });

    it("expiry otomatis: aktivitas habis TTL -> ACTIVE jatuh ke DORMANT deterministik", () => {
        const { rt, host, clock } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("SPEAKING", { ttlMs: 500 });
        clock.advanceMs(499);
        assert.equal(rt.getPresenceStatus().activeActivityCount, 1);
        clock.advanceMs(2); // total 501ms > ttl
        const status = rt.getPresenceStatus();
        assert.equal(status.activeActivityCount, 0);
        assert.equal(status.lifecycleState, LIFECYCLE.DORMANT);
        assert.equal(rt.getCounters().activitiesExpired, 1);
    });

    it("ttl invalid ditolak sebelum efek apa pun", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        for (const bad of [0, -100, Infinity, "besok"]) {
            const r = rt.beginActivity("THINKING", { ttlMs: bad });
            assert.equal(r.code, "REJECTED_INVALID_ARGUMENT");
        }
        assert.equal(rt.getPresenceStatus().activeActivityCount, 0);
    });

    it("maxActivities bounded: melebihi batas gagal tertutup tanpa eviction senyap", () => {
        const { rt, host } = createBootedRuntime({ config: { maxActivities: 3 } });
        rt.summon(host);
        for (let i = 0; i < 3; i++) {
            assert.equal(rt.beginActivity("THINKING").ok, true);
        }
        const overflow = rt.beginActivity("LISTENING");
        assert.equal(overflow.ok, false);
        assert.equal(overflow.code, "REJECTED_BOUND_EXCEEDED");
        assert.equal(rt.getPresenceStatus().activeActivityCount, 3);
    });

    it("aktivitas terakhir selesai -> ACTIVE>DORMANT dengan sebab ACTIVITY_COMPLETED", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("THINKING");
        const result = rt.endActivity(token, { reason: "jawaban selesai" });
        assert.equal(result.code, "OK_COMMITTED");
        assert.deepEqual(
            [result.from, result.to],
            [LIFECYCLE.ACTIVE, LIFECYCLE.DORMANT]
        );
    });
});

describe("presence overlapping activities — precedence presentasi (P8)", () => {
    function bootedActive() {
        const kit = createBootedRuntime();
        kit.rt.summon(kit.host);
        return kit;
    }

    it("THINKING lalu SPEAKING: presentasi SPEAKING (bukan urutan kedatangan acak)", () => {
        const { rt, host } = bootedActive();
        rt.beginActivity("THINKING");
        rt.beginActivity("SPEAKING");
        assert.equal(rt.getPresenceStatus().activityPresentation, "SPEAKING");
    });

    it("SPEAKING selesai saat THINKING masih hidup: tetap ACTIVE, presentasi THINKING", () => {
        const { rt, host } = bootedActive();
        const think = rt.beginActivity("THINKING").token;
        const speak = rt.beginActivity("SPEAKING").token;
        rt.endActivity(speak);
        const status = rt.getPresenceStatus();
        assert.equal(status.lifecycleState, "ACTIVE");
        assert.equal(status.activityPresentation, "THINKING");
        void think;
    });

    it("barge-in fondasi: LISTENING mendominasi SPEAKING dalam presentasi", () => {
        const { rt, host } = bootedActive();
        rt.beginActivity("SPEAKING");
        rt.beginActivity("LISTENING");
        assert.equal(rt.getPresenceStatus().activityPresentation, "LISTENING");
    });

    it("precedence hanya presentasi: SPEAKING tetap hidup walau LISTENING tampil", () => {
        const { rt, host } = bootedActive();
        const speak = rt.beginActivity("SPEAKING").token;
        rt.beginActivity("LISTENING");
        assert.equal(rt.getPresenceStatus().activityPresentation, "LISTENING");
        assert.equal(rt.endActivity(speak).code, "OK_COMMITTED", "SPEAKING bisa diselesaikan normal");
        assert.equal(rt.getPresenceStatus().activityPresentation, "LISTENING");
    });

    it("multiple reasoning tasks: THINKING ganda terhitung 2, IDLE saat semua tuntas", () => {
        const { rt, host } = bootedActive();
        const a = rt.beginActivity("THINKING").token;
        const b = rt.beginActivity("THINKING").token;
        assert.equal(rt.getPresenceStatus().activeActivityCount, 2);
        rt.endActivity(a);
        rt.endActivity(b);
        const status = rt.getPresenceStatus();
        assert.equal(status.activeActivityCount, 0);
        assert.equal(status.activityPresentation, "DORMANT");
    });
});

describe("presence barge-in foundation — inersia (P9)", () => {
    it("rekomendasi interupsi TIDAK menghentikan aktivitas SPEAKING", () => {
        const { rt, host, voice } = createBootedRuntime();
        rt.summon(host);
        const speak = rt.beginActivity("SPEAKING").token;
        const r = rt.recommendInterruption(speak, { producer: voice, reason: "user-talk" });
        assert.equal(r.ok, true);
        assert.equal(r.code, "OK_RECORDED");
        const status = rt.getPresenceStatus();
        assert.equal(status.activeActivityCount, 1, "aktivitas tetap hidup");
        assert.equal(rt.getCounters().interruptionRecommendations, 1);
    });

    it("rekomendasi tercatat sebagai notifikasi observer bertipe INTERRUPTION_RECOMMENDED", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const events = [];
        rt.subscribe((event) => events.push(event));
        const speak = rt.beginActivity("LISTENING").token;
        rt.recommendInterruption(speak);
        const types = events.map((e) => e.type);
        assert.equal(types.includes("INTERRUPTION_RECOMMENDED"), true);
    });

    it("rekomendasi atas token palsu/stale/nonaktif ditolak atau noop tanpa mutasi", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const live = rt.beginActivity("SPEAKING").token;
        assert.equal(rt.recommendInterruption({ id: live.id }).code, "REJECTED_FORGED_TOKEN");
        const done = rt.beginActivity("THINKING").token;
        rt.endActivity(done);
        const before = JSON.stringify(rt.getPresenceStatus());
        const terminal = rt.recommendInterruption(done);
        assert.equal(terminal.ok, false);
        assert.equal(terminal.code, "REJECTED_TERMINAL_ACTIVITY");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });
});
