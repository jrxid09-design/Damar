/**
 * Kit pengujian Presence Runtime V0: runtime ter-boot deterministik
 * dengan jam manual dan produsen tepercaya siap pakai.
 */

const assert = require("node:assert/strict");
const {
    createPresenceRuntime,
    createManualClock,
    PRODUCER_KIND,
    LIFECYCLE,
    CAUSE
} = require("../../../src/runtime/presence");

function createBootedRuntime({ startMs = 1_000, config = {} } = {}) {
    const clock = createManualClock(startMs);
    const rt = createPresenceRuntime({ clock, config });
    const host = rt.registerProducer(PRODUCER_KIND.HOST, "test-host");
    const interaction = rt.registerProducer(PRODUCER_KIND.INTERACTION, "test-interaction");
    const resource = rt.registerProducer(PRODUCER_KIND.RESOURCE_GOVERNOR, "test-resource");
    const recovery = rt.registerProducer(PRODUCER_KIND.RECOVERY, "test-recovery");
    const voice = rt.registerProducer(PRODUCER_KIND.VOICE, "test-voice");

    const boot = rt.boot(host);
    assert.equal(boot.ok, true, "boot harus sukses di kit pengujian");
    rt.markInitializing();
    rt.markInitializationComplete();
    assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);

    return { clock, rt, host, interaction, resource, recovery, voice };
}

function reachState(rt, actor, target) {
    if (rt.lifecycleState === target) return;
    if (target === LIFECYCLE.AWAKE) {
        const r = rt.summon(actor);
        assert.equal(r.ok, true);
    }
    else if (target === LIFECYCLE.ACTIVE) {
        rt.summon(actor);
        const begun = rt.beginActivity("ATTENDING", { producer: actor });
        assert.equal(begun.ok, true);
    }
}

module.exports = { createBootedRuntime, reachState, LIFECYCLE, CAUSE };
