const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, HEALTH, DEGRADED_REASON
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence recovery — presence memetakan, tidak memulihkan (P16)", () => {
    it("DEGRADED>RECOVERING lewat requestRecovery; health RECOVERING", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.RECOVERY_REQUIRED });
        const r = rt.requestRecovery(recovery);
        assert.equal(r.code, "OK_COMMITTED");
        assert.deepEqual([r.from, r.to], ["DEGRADED", "RECOVERING"]);
        assert.equal(rt.getPresenceStatus().health, HEALTH.RECOVERING);
    });

    it("RECOVERY_COMPLETED -> DORMANT (runtime hidup kembali, tak mengklaim state lama)", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        rt.requestRecovery(recovery);
        const done = rt.completeRecovery(recovery);
        assert.deepEqual([done.from, done.to], ["RECOVERING", "DORMANT"]);
        assert.equal(rt.getPresenceStatus().health, HEALTH.HEALTHY);
    });

    it("RECOVERY_DEGRADED -> DEGRADED (pulih sebagian jujur direpresentasikan)", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE });
        rt.requestRecovery(recovery);
        const partial = rt.degradeRecovery(recovery);
        assert.deepEqual([partial.from, partial.to], ["RECOVERING", "DEGRADED"]);
    });

    it("RECOVERY_FAILED -> FAILED; FAILED terminal bagi recovery lanjutan", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.UNKNOWN });
        rt.requestRecovery(recovery);
        const failed = rt.failRecovery(recovery, "korup total");
        assert.deepEqual([failed.from, failed.to], ["RECOVERING", "FAILED"]);
        const again = rt.requestRecovery(recovery);
        assert.equal(again.ok, false);
        assert.equal(rt.getPresenceStatus().health, HEALTH.FAILED);
    });

    it("recovery dari AWAKE sah; recovery dari OFFLINE ditolak fail closed", () => {
        const presence = require("../../src/runtime/presence");
        const { rt, host, recovery } = createBootedRuntime();
        rt.summon(host);
        assert.equal(rt.requestRecovery(recovery).code, "OK_COMMITTED");
        assert.equal(rt.lifecycleState, "RECOVERING");

        const raw = presence.createPresenceRuntime({
            clock: presence.createManualClock(3)
        });
        const orphan = raw.registerProducer(presence.PRODUCER_KIND.RECOVERY, "rec");
        const fromOffline = raw.requestRecovery(orphan);
        assert.equal(fromOffline.ok, false);
        assert.equal(fromOffline.code, "REJECTED_INVALID_TRANSITION");
    });

    it("sebab recovery palsu lewat requestTransition umum ditolak bila edge/sebab tak cocok", () => {
        const { rt, recovery } = createBootedRuntime();
        const r = rt.requestTransition({
            to: LIFECYCLE.RECOVERING,
            cause: "USER_SUMMON",
            producer: recovery
        });
        assert.equal(r.ok, false);
        assert.equal(["REJECTED_INVALID_TRANSITION", "REJECTED_INVALID_CAUSE"].includes(r.code), true);
    });
});
