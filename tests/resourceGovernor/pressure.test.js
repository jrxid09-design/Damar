"use strict";

const test = require("node:test");
const { assert, governorFactory } = require("./helpers");
const { computePressureBand } = governorFactory.pressure;

function cfg() {
    return governorFactory.config.validateResourceGovernorConfig({});
}

function snap(over = {}) {
    return {
        observerHealthy: true,
        totalMemBytes: 2e9,
        freeMemBytes: 1e9,
        heapUsedBytes: 0.25e9,
        heapLimitBytes: 4e9,
        eventLoopLagMs: 5,
        ...over
    };
}

test("pressure: all signals normal => NORMAL", () => {
    const r = computePressureBand({ snapshot: snap(), config: cfg() });
    assert.equal(r.band, "NORMAL");
});

test("pressure: host used-memory ratio drives band (worst-of wins)", () => {
    const c = cfg();
    assert.equal(computePressureBand({ snapshot: snap({ freeMemBytes: 0.7e9 }), config: c }).band, "ELEVATED");
    assert.equal(computePressureBand({ snapshot: snap({ freeMemBytes: 0.4e9 }), config: c }).band, "HIGH");
    assert.equal(computePressureBand({ snapshot: snap({ freeMemBytes: 0.16e9 }), config: c }).band, "CRITICAL");
});

test("pressure: process heap ratio contributes independently of host", () => {
    const r = computePressureBand({ snapshot: snap({ heapUsedBytes: 3.4e9, heapLimitBytes: 4e9 }), config: cfg() });
    assert.equal(r.band, "HIGH");
});

test("pressure: event-loop lag alone can reach CRITICAL even with perfect RAM", () => {
    const r = computePressureBand({ snapshot: snap({ eventLoopLagMs: 900, freeMemBytes: 1.9e9 }), config: cfg() });
    assert.equal(r.band, "CRITICAL");
    assert.equal(r.contributions.lagBand, "CRITICAL");
});

test("pressure: hard floor forces CRITICAL", () => {
    const c = governorFactory.config.validateResourceGovernorConfig({
        memoryThresholds: { hostHardFloorBytes: 300 }
    });
    const r = computePressureBand({ snapshot: snap({ freeMemBytes: 250 }), config: c });
    assert.equal(r.band, "CRITICAL");
    assert.equal(r.contributions.hardFloorHit, true);
});

test("pressure: unhealthy observation yields UNKNOWN, never NORMAL", () => {
    const r = computePressureBand({ snapshot: { observerHealthy: false }, config: cfg() });
    assert.equal(r.band, "UNKNOWN");
});

function psnap(over = {}) {
    return {
        observerHealthy: true,
        totalMemBytes: 16e9,
        freeMemBytes: 8e9,
        rssBytes: 2e9,
        heapUsedBytes: 0.5e9,
        heapLimitBytes: 4e9,
        externalBytes: 5e7,
        arrayBuffersBytes: 2e7,
        eventLoopLagMs: 5,
        ...over
    };
}

test("pressure: large RSS with small heap raises footprint band", () => {
    const r = computePressureBand({
        snapshot: psnap({ rssBytes: 14e9 }),
        config: cfg()
    });
    assert.equal(r.band, "HIGH");
    assert.equal(r.contributions.footprintBand, "HIGH");
});

test("pressure: RSS beyond host memory clamps to CRITICAL", () => {
    const r = computePressureBand({
        snapshot: psnap({ rssBytes: 40e9 }),
        config: cfg()
    });
    assert.equal(r.band, "CRITICAL");
});

test("pressure: external/arrayBuffer-heavy runtime is detected even with small heap", () => {
    const r = computePressureBand({
        snapshot: psnap({
            externalBytes: 3.4e9,
            arrayBuffersBytes: 0,
            heapUsedBytes: 0.1e9
        }),
        config: cfg()
    });
    assert.equal(r.band, "HIGH");
    assert.ok(r.contributions.nativeRatio >= 0.8);
});

test("pressure: real V8 heap limit (heap_size_limit) differs from heapTotal and drives v8 band", async () => {
    const { createHostResourceObserver } = require("../../src/runtime/resourceGovernor/observer");
    const obs = createHostResourceObserver();
    try {
        const raw = obs.observe();
        assert.ok(Number.isFinite(raw.heapLimitBytes) && raw.heapLimitBytes > 0);
        assert.notEqual(raw.heapLimitBytes, raw.heapTotalBytes);
        const r = computePressureBand({ snapshot: { observerHealthy: true, ...raw }, config: cfg() });
        assert.notEqual(r.band, "UNKNOWN");
        assert.ok(r.contributions.v8HeapRatio !== null && r.contributions.v8Band !== null);
    } finally {
        obs.close();
    }
});

test("pressure: healthy process values remain NORMAL under the full formula", () => {
    const r = computePressureBand({ snapshot: psnap(), config: cfg() });
    assert.equal(r.band, "NORMAL");
    assert.equal(r.contributions.hardFloorHit, false);
});

test("pressure: malformed numeric readings fail toward UNKNOWN, not NORMAL", () => {
    const r = computePressureBand({
        snapshot: {
            observerHealthy: true, totalMemBytes: "big", freeMemBytes: null,
            rssBytes: NaN, heapUsedBytes: undefined, heapLimitBytes: -1
        },
        config: cfg()
    });
    assert.equal(r.band, "UNKNOWN");
});

test("hard floor: default config resolves and stores exactly 256 MiB", () => {
    const c = cfg();
    assert.equal(c.memoryThresholds.hostHardFloorBytes, 256 * 1024 * 1024);
});

test("hard floor: default floor triggers CRITICAL even when ratio bands stay low", () => {
    const c = governorFactory.config.validateResourceGovernorConfig({
        memoryThresholds: {
            hostUsedMemoryRatio: { elevated: 0.99, high: 0.995, critical: 0.999 }
        }
    });
    const r = computePressureBand({
        snapshot: psnap({
            totalMemBytes: 16 * 1024 ** 3,
            freeMemBytes: 128 * 1024 * 1024
        }),
        config: c
    });
    assert.equal(r.contributions.hostBand, "ELEVATED", "ratio band alone stays below CRITICAL");
    assert.equal(r.contributions.hardFloorHit, true);
    assert.equal(r.band, "CRITICAL");
});

test("hard floor: free memory above the default floor does not trigger it by itself", () => {
    const r = computePressureBand({
        snapshot: psnap({
            totalMemBytes: 16 * 1024 ** 3,
            freeMemBytes: 1024 * 1024 * 1024
        }),
        config: cfg()
    });
    assert.equal(r.contributions.hardFloorHit, false);
    assert.notEqual(r.band, "UNKNOWN");
});

test("hard floor: explicit custom floor is validated, stored, and honoured", () => {
    const c = governorFactory.config.validateResourceGovernorConfig({
        memoryThresholds: { hostHardFloorBytes: 2 * 1024 ** 3 }
    });
    assert.equal(c.memoryThresholds.hostHardFloorBytes, 2 * 1024 ** 3);
    const hit = computePressureBand({ snapshot: psnap({ freeMemBytes: 1.5 * 1024 ** 3 }), config: c });
    assert.equal(hit.contributions.hardFloorHit, true);
    assert.equal(hit.band, "CRITICAL");
});
