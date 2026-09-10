"use strict";

/**
 * W6-R3-01 — CANONICAL AUTHORITY OWNERSHIP (composition-root closure, Pattern A).
 *
 * CONSTRUCTED INSTANCE != CANONICAL OWNER.
 * CLASS BRAND != CANONICAL PROVENANCE.
 * FIRST BINDER != CANONICAL AUTHORITY.
 *
 * Prior repair branded EVERY `new AuthorityRegistry(...)` at construction
 * (module-private WeakSet in registry.js), so any caller-created registry
 * passed the "canonical" brand and an early caller could capture the first
 * bind. That is not acceptable.
 *
 * THIS repair: an AuthorityRegistry becomes canonical ONLY when it is
 * produced by the composition-root factory below. The brand happens inside
 * this module's closure; the registration function (__canonify) is never
 * exported and cannot be reached by an importer (not on any object, not
 * Symbol.for, not serializable). A caller constructing a registry directly
 * via `new AuthorityRegistry()` is NOT canonical. Cloned/spread/serialized/
 * monkey-patched copies of a canonical instance are NOT canonical (brand is
 * object identity in a closure-private WeakSet).
 */

const CANONICAL_REGISTRIES = new WeakSet();

/** Closure-private. No export; reachable only from this module. */
function __canonify(instance) {
    CANONICAL_REGISTRIES.add(instance);
    return instance;
}

/**
 * The ONLY canonical registry factory. The real application composition root
 * calls this to obtain the ONE canonical AuthorityRegistry; every Wave6
 * security consumer resolves authority against it. This is NOT a first-wins
 * binder and NOT a brand-anything API: it constructs the instance itself and
 * brands it in the same closure step. Callers that need a registry for tests /
 * local use must construct `new AuthorityRegistry(...)` (non-canonical).
 */
function createCanonicalAuthorityRegistry({ store, clock }) {
    if (!store || typeof store.getCapability !== "function") {
        throw new TypeError("createCanonicalAuthorityRegistry requires a functional store");
    }
    if (!clock || typeof clock.nowIso !== "function" || typeof clock.nowMs !== "function") {
        throw new TypeError("createCanonicalAuthorityRegistry requires a clock { nowIso, nowMs }");
    }
    const AuthorityRegistry = require("./registry").AuthorityRegistry;
    const instance = new AuthorityRegistry({ store, clock });
    return __canonify(instance);
}

/** Brand-first ownership predicate. No property access on unbranded values. */
function isCanonicalAuthorityRegistry(value) {
    return value !== null && typeof value === "object" &&
        CANONICAL_REGISTRIES.has(value);
}

module.exports = Object.freeze({
    createCanonicalAuthorityRegistry,
    isCanonicalAuthorityRegistry
});