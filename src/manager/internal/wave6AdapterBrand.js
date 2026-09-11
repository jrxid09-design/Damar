"use strict";

/**
 * W6-R4-04 — CANONICAL WAVE6 LANE-3 ADAPTER BRAND (leaf module).
 *
 * The Manager's Lane-3 distributed-execution seam (inside
 * createDamarManagerComposition) ONLY accepts an adapter that is BRANDED by
 * this module. `__brandWave6Adapter` is composition-internal (consumed from the
 * production Wave 6 composition / test-only harness); it is never exported from
 * any public package surface.
 *
 * CALLER-CONTROLLED SEAM != CANONICAL EXECUTION.
 * A duck-typed { tryDistributed } object cannot reach the Manager.
 */

const ADAPTERS = new WeakSet();

/** Composition-internal brand — not exported from public surfaces. */
function __brandWave6Adapter(adapter) {
    if (adapter === null || typeof adapter !== "object") {
        throw new TypeError("__brandWave6Adapter requires an adapter object");
    }
    ADAPTERS.add(adapter);
    return adapter;
}

/** Read-only recognition predicate. */
function isCanonicalWave6ExecutionAdapter(value) {
    return value !== null && typeof value === "object" && ADAPTERS.has(value);
}

module.exports = Object.freeze({
    isCanonicalWave6ExecutionAdapter,
    __brandWave6Adapter
});