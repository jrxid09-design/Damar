"use strict";

/**
 * Shared helpers for capability registry tests.
 *
 * Descriptors are descriptive-only (no `provenance` field). Provenance identity
 * originates from a registrar minted through the trusted composition root
 * `createCapabilityRuntime`, which returns only least-privilege registrars.
 */

const { CapabilityRegistry, createCapabilityRuntime } = require("../../src/capability/registry");

function descriptor(overrides = {}) {
    return {
        schemaVersion: 1,
        id: "filesystem.read",
        kind: "system",
        provider: "core",
        source: "core/runtime",
        operations: ["read"],
        ...overrides
    };
}

/**
 * Build a capability runtime plus its bound registrars. Returns:
 *   { registry, registrar (core), core, extension, device, provider,
 *     register(d) — register via the core registrar }
 */
function makeRegistry({ clock, ...rest } = {}) {
    const c = clock ?? { nowMs: () => 42 };
    const runtime = createCapabilityRuntime({
        clock: c,
        maxCapabilities: rest.maxCapabilities,
        registrars: { core: true, extension: "testext", device: "testdevice", provider: "testprovider" }
    });

    const { registry, registrars } = runtime;
    const core = registrars.core;

    return {
        c,
        registry,
        runtime,
        registrar: core,
        core,
        extension: registrars.extension,
        device: registrars.device,
        provider: registrars.provider,
        register: (d) => core.registerCanonical(d)
    };
}

module.exports = { descriptor, makeRegistry };
