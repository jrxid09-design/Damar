const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    createPresenceRuntime,
    createManualClock,
    PRODUCER_KIND,
    registerProducer,
    isGenuineProducer,
    LIFECYCLE
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence producers — model kepercayaan (P18)", () => {
    it("identitas terdaftar genuin: frozen, ber-id kanon, kind sah", () => {
        const { rt } = createBootedRuntime();
        const p = rt.registerProducer(PRODUCER_KIND.VOICE, "ardi");
        assert.equal(isGenuineProducer(p), true);
        assert.equal(Object.isFrozen(p), true);
        assert.match(p.id, /^producer:voice:\d+$/);
        assert.equal(p.kind, PRODUCER_KIND.VOICE);
    });

    it("kind tak dikenal ditolak saat registrasi", () => {
        const rt = createPresenceRuntime({ clock: createManualClock() });
        assert.throws(() => rt.registerProducer("SUPERADMIN"), /PRESENCE_PRODUCER_KIND_INVALID/);
        assert.throws(() => registerProducer("system"), /PRESENCE_PRODUCER_KIND_INVALID/);
    });

    it("plain object yang mengaku produsen TIDAK genuin", () => {
        const fake = { id: "producer:core:9999", kind: "CORE" };
        assert.equal(isGenuineProducer(fake), false);
        assert.equal(isGenuineProducer(null), false);
        assert.equal(isGenuineProducer("system"), false);
    });

    it("payload pemanggil tidak bisa mengaku 'system' lalu tepercaya — state byte-per-byte sama", () => {
        const { rt, host } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.requestTransition({
            to: LIFECYCLE.AWAKE,
            cause: "USER_SUMMON",
            producer: { id: host.id, kind: host.kind, claimed: "system", role: "system" },
            reason: "payload-claim"
        });
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("identitas genuin dari runtime LAIN tidak otomatis dipercaya di sini", () => {
        const a = createPresenceRuntime({ clock: createManualClock(1) });
        const b = createPresenceRuntime({ clock: createManualClock(1) });
        const foreign = a.registerProducer(PRODUCER_KIND.RECOVERY, "foreign");
        assert.equal(foreign.kind, PRODUCER_KIND.RECOVERY);
        const result = b.requestTransition({ to: LIFECYCLE.SHUTTING_DOWN, cause: "SHUTDOWN_REQUEST", producer: foreign });
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_UNREGISTERED_PRODUCER");
    });

    it("PresenceGenerationId kanon monoton dan berformat", () => {
        const rt = createPresenceRuntime({ clock: createManualClock() });
        const first = rt.generation;
        assert.match(first, /^presence-gen-\d{6}$/);
        rt.startNewGeneration("test");
        const second = rt.generation;
        assert.match(second, /^presence-gen-\d{6}$/);
        assert.ok(second > first);
    });
});
