"use strict";

/**
 * W6-R5-02 — WAVE6 LANE-3 ADAPTER RECOGNITION (leaf module).
 *
 * R5-02 design: the Manager ↔ Wave 6 adapter is constructed INSIDE the trusted
 * runtime composition and handed to the Manager as a concrete dependency. There
 * is no longer any "brand" primitive and no public/un-branded seam. A caller
 * cannot manufacture or install a Wave 6 adapter through any importable
 * function.
 *
 * A PRIVILEGED FUNCTION THAT CAN BE DIRECTLY IMPORTED IS NOT PRIVATE.
 *
 * The WeakSet + `markWave6Adapter` here are LEXICAL-ONLY: they are consumed by
 * the trusted production composition and the test-only composition harness.
 * `__brandWave6Adapter` (the legacy mutator) is intentionally GONE from this
 * module's exports. `isCanonicalWave6ExecutionAdapter` is a read-only predicate
 * retained for diagnostics/contract tests; it is not relied upon as the trust
 * boundary (closure ownership is).
 */

const ADAPTERS = new WeakSet();

/**
 * Lexical-only adapter ownership marker. NOT exported. The trusted production
 * composition and the test-only harness call this internally; no external caller
 * can import a mutator that brands an adapter.
 */
function markWave6Adapter(adapter) {
    if (adapter === null || typeof adapter !== "object") {
        throw new TypeError("markWave6Adapter requires an adapter object");
    }
    ADAPTERS.add(adapter);
    return adapter;
}

/** Read-only recognition predicate (retained for contract assertions). */
function isCanonicalWave6ExecutionAdapter(value) {
    return value !== null && typeof value === "object" && ADAPTERS.has(value);
}

module.exports = Object.freeze({
    isCanonicalWave6ExecutionAdapter
    // R5-02: NO markWave6Adapter / __brandWave6Adapter export — no importable
    // mutator. The Lane-3 adapter is owned by the trusted composition closure;
    // branding is not relied upon as a boundary.
});