"use strict";

const test = require("node:test");
const { assert, governorFactory, BASE_CONFIG } = require("./helpers");
const { validateResourceGovernorConfig, defaultResourceGovernorConfig, KNOWN_GROUPS } = governorFactory.config;

test("config: defaults validate and include every known group", () => {
    const cfg = defaultResourceGovernorConfig();
    for (const g of KNOWN_GROUPS) {
        assert.ok(Number.isInteger(cfg.groupLimits[g]) && cfg.groupLimits[g] >= 1);
    }
    assert.equal(cfg.unknownGroupPolicy, "reject");
});

test("config: explicit valid config round-trips frozen", () => {
    const cfg = validateResourceGovernorConfig(BASE_CONFIG);
    assert.equal(cfg.globalConcurrencyLimit, 4);
    assert.equal(Object.isFrozen(cfg), true);
});

test("config: malformed fails closed — non-integer / out-of-range scalars", () => {
    for (const [patch, msg] of [
        [{ globalConcurrencyLimit: 0 }, /globalConcurrencyLimit/],
        [{ globalConcurrencyLimit: 2.5 }, /globalConcurrencyLimit/],
        [{ maxQueue: -1 }, /maxQueue/],
        [{ leaseTtlMs: 999 }, /leaseTtlMs/],
        [{ historyCapacity: 1 }, /historyCapacity/]
    ]) {
        assert.throws(() => validateResourceGovernorConfig({ ...BASE_CONFIG, ...patch }), msg);
    }
});

test("config: group limit exceeding global fails closed", () => {
    assert.throws(() =>
        validateResourceGovernorConfig({ globalConcurrencyLimit: 2, groupLimits: { default: 5 } }),
        /exceeds globalConcurrencyLimit/);
});

test("config: unknown group name in config fails closed (closed group set)", () => {
    assert.throws(() =>
        validateResourceGovernorConfig({ groupLimits: { "my-secret-group": 3 } }),
        /closed/);
});

test("config: inverted pressure thresholds fail closed", () => {
    assert.throws(() =>
        validateResourceGovernorConfig({
            memoryThresholds: { hostUsedMemoryRatio: { elevated: 0.9, high: 0.5, critical: 0.3 } }
        }),
        /elevated < high <= critical/);
    assert.throws(() =>
        validateResourceGovernorConfig({ eventLoopLagMs: { elevated: 900, high: 100, critical: 50 } }),
        /elevated < high <= critical/);
});

test("config: unknownGroupPolicy other than reject fails closed", () => {
    assert.throws(() =>
        validateResourceGovernorConfig({ unknownGroupPolicy: "map-to-default" }),
        /unknownGroupPolicy/);
});

test("config: non-object config fails closed", () => {
    assert.throws(() => validateResourceGovernorConfig(null), /INVALID_RESOURCE_GOVERNOR_CONFIG/);
    assert.throws(() => validateResourceGovernorConfig([1]), /INVALID_RESOURCE_GOVERNOR_CONFIG/);
});
