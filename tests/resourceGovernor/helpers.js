"use strict";

const assert = require("node:assert/strict");
const governorFactory = require("../../src/runtime/resourceGovernor");

function manualClock(startMs = 1_000_000) {
    let t = startMs;
    return {
        nowMs: () => t,
        advance(ms) { t += ms; return t; },
        set(ms) { t = ms; return t; }
    };
}

class FakeObserver {
    constructor({ totalMemBytes = 16e9, freeMemBytes = 8e9, heapUsedBytes = 1e9,
        heapLimitBytes = 4e9, rssBytes = 2e9, externalBytes = 5e7,
        arrayBuffersBytes = 2e7, eventLoopLagMs = 5 } = {}) {
        this.totalMemBytes = totalMemBytes;
        this.freeMemBytes = freeMemBytes;
        this.heapUsedBytes = heapUsedBytes;
        this.heapLimitBytes = heapLimitBytes;
        this.rssBytes = rssBytes;
        this.externalBytes = externalBytes;
        this.arrayBuffersBytes = arrayBuffersBytes;
        this.eventLoopLagMs = eventLoopLagMs;
        this.observeCalls = 0;
    }

    observe() {
        if (this.shouldThrow) throw new Error("observer offline");
        this.observeCalls++;
        return {
            totalMemBytes: this.totalMemBytes,
            freeMemBytes: this.freeMemBytes,
            rssBytes: this.rssBytes,
            heapUsedBytes: this.heapUsedBytes,
            heapLimitBytes: this.heapLimitBytes,
            externalBytes: this.externalBytes,
            arrayBuffersBytes: this.arrayBuffersBytes,
            eventLoopLagMs: this.eventLoopLagMs
        };
    }
}

class ThrowingObserver {
    observe() { throw new Error("wmi unavailable"); }
}

function makeGovernor({ config = {}, observer, clock } = {}) {
    return governorFactory.createResourceGovernor({
        config,
        observer: observer ?? new FakeObserver(),
        clock: clock ?? manualClock()
    });
}

const BASE_CONFIG = Object.freeze({
    globalConcurrencyLimit: 4,
    groupLimits: { "llm-heavy": 1, default: 4 },
    maxQueue: 8,
    leaseTtlMs: 60_000
});

function demand(overrides = {}) {
    return { workloadClass: "AGENT", concurrencyGroup: "default", ...overrides };
}

module.exports = {
    assert, manualClock, FakeObserver, ThrowingObserver,
    makeGovernor, BASE_CONFIG, demand, governorFactory
};
