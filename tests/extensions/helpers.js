"use strict";

/** Shared helpers for extension kernel tests. */

const CLOCK_START = 1_000_000;

function manualClock(startMs = CLOCK_START) {
    let now = startMs;
    return {
        get nowMs() { return now; },
        clock: { nowMs: () => now },
        tick(delta = 1) { now += delta; return now; }
    };
}

function manifest(overrides = {}) {
    return {
        schemaVersion: 1,
        extensionId: "test.alpha",
        name: "Alpha",
        version: "1.0.0",
        ...overrides
    };
}

function makeRegistry({ clock, ...rest } = {}) {
    const { ExtensionRegistry } = require("../../src/extensions/registry");
    const c = clock ?? manualClock();
    return {
        c,
        registry: new ExtensionRegistry({ clock: c.clock, ...rest })
    };
}

/** Register + install + enable in one step. Returns the registry. */
function enableExtension(registry, overrides, opts = {}) {
    registry.register(manifest(overrides), opts);
    registry.install(overrides.extensionId ?? "test.alpha");
    registry.enable(overrides.extensionId ?? "test.alpha");
    return registry;
}

module.exports = { manualClock, manifest, makeRegistry, enableExtension, CLOCK_START };
