const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    DEFAULT_PRESENCE_CONFIG,
    validatePresenceConfig,
    createPresenceRuntime,
    createManualClock
} = require("../../src/runtime/presence");

describe("presence config — batas terpusat (P27)", () => {
    it("default config beku dan semua nilai integer positif", () => {
        assert.equal(Object.isFrozen(DEFAULT_PRESENCE_CONFIG), true);
        for (const value of Object.values(DEFAULT_PRESENCE_CONFIG)) {
            assert.ok(Number.isInteger(value) && value > 0);
        }
    });

    it("kunci wajib lengkap: activities, ownerWaits, degradedReasons, history, diagnostics, subscribers, TTL", () => {
        for (const key of [
            "maxActivities", "maxActivityTombstones", "maxOwnerWaits", "maxDegradedReasons",
            "maxHistory", "maxDiagnostics", "maxSubscribers", "activityTtlMs", "ownerWaitTtlMs"
        ]) {
            assert.ok(key in DEFAULT_PRESENCE_CONFIG, `kunci ${key} harus ada`);
        }
    });

    it("override sah di-merge dan hasilnya beku", () => {
        const cfg = validatePresenceConfig({ maxActivities: 3 });
        assert.equal(cfg.maxActivities, 3);
        assert.equal(cfg.maxHistory, DEFAULT_PRESENCE_CONFIG.maxHistory);
        assert.equal(Object.isFrozen(cfg), true);
    });

    it("menolak bound nol/negatif/non-integer dengan TypeError", () => {
        assert.throws(() => validatePresenceConfig({ maxActivities: 0 }), TypeError);
        assert.throws(() => validatePresenceConfig({ maxHistory: -5 }), TypeError);
        assert.throws(() => validatePresenceConfig({ maxSubscribers: 1.5 }), TypeError);
    });

    it("menolak kunci tak dikenal (fail closed)", () => {
        assert.throws(() => validatePresenceConfig({ maxUnboundedThings: 10 }), /PRESENCE_CONFIG_INVALID/);
    });

    it("runtime memakai config ter-validasi, bukan objek mentah", () => {
        const rt = createPresenceRuntime({
            clock: createManualClock(),
            config: { maxDegradedReasons: 2 }
        });
        assert.equal(rt.config.maxDegradedReasons, 2);
        assert.equal(Object.isFrozen(rt.config), true);
    });
});

describe("presence clock — determinisme (P20)", () => {
    it("jam manual hanya bergerak saat dimajukan", () => {
        const clock = createManualClock(5000);
        assert.equal(clock.nowMs(), 5000);
        assert.equal(clock.nowMs(), 5000);
        clock.advanceMs(250);
        assert.equal(clock.nowMs(), 5250);
    });

    it("advanceMs menolak delta negatif/non-numerik", () => {
        const clock = createManualClock();
        assert.throws(() => clock.advanceMs(-1), TypeError);
        assert.throws(() => clock.advanceMs("banyak"), TypeError);
    });

    it("setMs memvalidasi input", () => {
        const clock = createManualClock();
        clock.setMs(42);
        assert.equal(clock.nowMs(), 42);
        assert.throws(() => clock.setMs(-7), TypeError);
    });
});
