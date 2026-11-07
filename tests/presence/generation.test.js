const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, CAUSE, ACTIVITY_MODE
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence generation — peristiwa telat dari lifecycle lama (P6, P26)", () => {
    it("token dari generasi lama ditolak STALE_GENERATION tanpa mutasi", () => {
        const { rt, host, clock } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("THINKING");
        assert.ok(token);
        rt.startNewGeneration("restart-simulasi");
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.endActivity(token);
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_STALE_GENERATION");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("startNewGeneration menandai aktivitas nonterminal INTERRUPTED dan reset ke OFFLINE", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("SPEAKING");
        const result = rt.startNewGeneration("crash-recovery");
        assert.equal(result.code, "OK_COMMITTED");
        assert.equal(rt.lifecycleState, LIFECYCLE.OFFLINE);
        const status = rt.getPresenceStatus();
        assert.equal(rt.getCounters().activitiesInterrupted, 1);
        assert.equal(status.activeActivityCount, 0);
    });

    it("TIDAK ada resume otomatis: SPEAKING lama tidak melanjutkan setelah generasi baru (P26)", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("SPEAKING");
        rt.beginActivity("LISTENING");
        rt.startNewGeneration();
        const status = rt.getPresenceStatus();
        assert.equal(status.lifecycleState, LIFECYCLE.OFFLINE);
        assert.equal(status.activityPresentation, "OFFLINE");
        assert.equal(status.activeActivityCount, 0);
    });

    it("owner waits dihapus saat generasi maju — approval lama tak mewarisi", () => {
        const { rt, resource } = createBootedRuntime();
        rt.beginOwnerWait({ producer: resource, approvalRequestId: "req-1" });
        assert.equal(rt.getPresenceStatus().waitingOwnerCount, 1);
        rt.startNewGeneration();
        assert.equal(rt.getPresenceStatus().waitingOwnerCount, 0);
    });

    it("degraded reasons direset pada generasi baru", () => {
        const { rt, resource } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: "MODEL_UNAVAILABLE" });
        assert.equal(rt.getPresenceStatus().health, "DEGRADED");
        rt.startNewGeneration();
        assert.equal(rt.getPresenceStatus().health, "UNKNOWN");
        assert.equal(rt.getPresenceStatus().degradedReasons.length, 0);
    });

    it("rekomendasi interupsi atas token stale ditolak", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const { token } = rt.beginActivity("SPEAKING");
        rt.startNewGeneration();
        const r = rt.recommendInterruption(token);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_STALE_GENERATION");
    });

    it("generasi baru tetap menjalani siklus boot penuh (fresh generation)", () => {
        const { rt, host } = createBootedRuntime();
        rt.startNewGeneration();
        assert.equal(rt.boot(host).code, "OK_COMMITTED");
        rt.markInitializing(host);
        rt.markInitializationComplete(host);
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
    });
});
