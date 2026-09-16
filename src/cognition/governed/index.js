"use strict";

/**
 * FG-03 GOVERNED MODE FOUNDATION (ADR-17, ARCH-Q-02, ratified).
 *
 * ACC subdomain `src/cognition/governed/**` -- the canonical, reusable
 * off/shadow/governed gate and GovernedCognitiveProjection guarantees.
 * This is a FOUNDATION, not a new authority owner: it never touches
 * Authority, never constructs an ActionIntent, never dispatches a tool,
 * and holds no mutable state of its own (every export below is a pure
 * function or a frozen constant -- there is nothing here to persist,
 * restart, or leak).
 *
 * MODEL != AUTHORITY. COGNITION != AUTHORITY. ACC OUTPUT != EXECUTION
 * AUTHORITY. A GovernedCognitiveProjection is always advisory-only data;
 * turning it into an intent, a grant, or a permission is the caller's
 * violation, not something this module can prevent by itself -- so it
 * makes the violation impossible to construct *through* this module's
 * own API surface, and `assertNoAuthorityShapedFields`/
 * `validateGovernedCognitiveProjection` exist so every consumer can
 * cheaply prove a projection it received (or built) carries none.
 *
 * Extracted from `src/cognition/longhorizon/index.js`, which was the
 * first (and until now, only) governed-mode producer -- longhorizon now
 * imports MODES/AUTHORITY_SHAPED_KEYS/assertNoAuthorityShapedFields/
 * resolveMode/isInfluenceAllowed from here instead of holding its own
 * copies, closing the duplication before a second lane (W8-L2/L4/L6)
 * had a chance to grow a THIRD copy independently.
 *
 * Restart/recovery (ADR-17 "reversible to SHADOW and OFF"): this module
 * holds no state, so there is nothing to resume -- every caller passes
 * `mode` explicitly at construction (matching the existing off/shadow
 * convention in `src/cognition/config/ACCConfig.js` and `longhorizon`),
 * and `resolveMode` fails closed to "off" for anything unrecognized,
 * missing, or hostile. A process restart can therefore never silently
 * resurrect a live/permissive mode -- the caller must say so again,
 * every time.
 */

const { types: utilTypes } = require("node:util");
const { MODES } = require("./bounds");
const { REASONS, GovernedError, fail } = require("./errors");

/**
 * Proxy probe via internal slot: zero traps, and correct for a revoked Proxy
 * too. Reflection on a Proxy EXECUTES caller code, and an `ownKeys` trap can
 * HIDE a field from the walk -- so this guard must run BEFORE the first
 * reflection, not be discovered by it.
 */
function isProxyValue(value) {
    try {
        return utilTypes.isProxy(value);
    } catch {
        return true;
    }
}

/**
 * Authority-shaped vocabulary. Independent audit of 0b8abb7 found the
 * original list covered only this repo's historical field NAMES
 * (authProof/capabilityGrant/executionLease/...) and therefore let equally
 * authoritative synonyms through: a projection carrying `authority`,
 * `permission`, `approved`, `decision`, or a bearer/lease token validated
 * clean. The list below is the containment boundary, so it is deliberately
 * vocabulary-family based rather than a record of names seen so far.
 */
const AUTHORITY_SHAPED_KEYS = Object.freeze([
    // historical names this repo already used
    "authorityDecision", "allow", "grant", "owner", "authProof",
    "capabilityGrant", "executionLease", "executor", "route", "trustedNode", "rootAuthority",
    // authority/permission family
    "authority", "authorities", "authorized", "authorization", "authorizations",
    "permission", "permissions", "privilege", "privileges",
    "approved", "approval", "approvedBy",
    // decision/grant family
    "decision", "decisions", "decisionMaker", "granted", "grants", "grantedBy",
    // bearer-token / lease family
    "lease", "leases", "leasedUntil", "bearer", "bearerToken", "leaseToken", "authToken",
    // credential family
    "credential", "credentials", "creds", "secret", "secrets", "apiKey", "privateKey"
]);

// Bug review independen (extraksi FG-03, sibling langsung dari class
// round-14's AUD14-P1-1/round-30's AUD30-ADV-1): recursion tanpa budget
// kedalaman/simpul bisa DoS pada proyeksi bersarang dalam; WeakSet
// mencegah crash pada referensi siklik. Sumber proyeksi ini SELALU
// lane cognition tepercaya (bukan input caller mentah), jadi ini
// pertahanan berlapis murah, bukan sanitisasi input adversarial.
const MAX_PROJECTION_DEPTH = 16;
const MAX_PROJECTION_NODES = 4096;

function walkForAuthorityShapedFields(value, label, seen, budget, depth, requireFrozen = false) {
    if (typeof value === "function") {
        throw new Error(`ACC governed: ${label} tidak boleh berupa fungsi`);
    }
    if (!value || typeof value !== "object") return;
    // A Proxy is refused outright. Without this, the walk's guarantee is
    // unsound twice over: `ownKeys`/`getOwnPropertyDescriptor` EXECUTE caller
    // code, and an `ownKeys` trap returning [] hides `authProof` from the
    // scan entirely. Independent audit of 0b8abb7 proved exactly that bypass.
    if (isProxyValue(value)) {
        throw new Error(`ACC governed: ${label} tidak dapat dibekukan/diverifikasi -- tidak boleh berupa Proxy`);
    }
    if (seen.has(value)) return;
    if (requireFrozen && !Object.isFrozen(value)) {
        throw new Error(`ACC governed: ${label} wajib dibekukan secara mendalam`);
    }
    if (requireFrozen) {
        let prototype;
        try {
            prototype = Object.getPrototypeOf(value);
        } catch {
            throw new Error(`ACC governed: ${label} tidak dapat diverifikasi dengan aman`);
        }
        const allowedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
        if (prototype !== null && prototype !== allowedPrototype) {
            throw new Error(`ACC governed: ${label} wajib berupa objek data biasa`);
        }
    }
    seen.add(value);
    if (depth > MAX_PROJECTION_DEPTH) {
        throw new Error(`ACC governed: ${label} terlalu dalam untuk diverifikasi dengan aman`);
    }
    budget.count += 1;
    if (budget.count > MAX_PROJECTION_NODES) {
        throw new Error(`ACC governed: ${label} melebihi batas jumlah simpul`);
    }
    let keys;
    try {
        keys = Reflect.ownKeys(value);
    } catch {
        throw new Error(`ACC governed: ${label} tidak dapat diverifikasi dengan aman`);
    }
    for (const key of keys) {
        if (typeof key === "string" && AUTHORITY_SHAPED_KEYS.includes(key)) {
            throw new Error(`ACC governed: ${label} tidak boleh membawa field '${key}'`);
        }
    }
    for (const key of keys) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
            throw new Error(`ACC governed: ${label} tidak dapat dibaca dengan aman`);
        }
        if (!descriptor || !("value" in descriptor)) {
            throw new Error(`ACC governed: ${label}.${String(key)} wajib berupa data property`);
        }
        walkForAuthorityShapedFields(descriptor.value, `${label}.${String(key)}`, seen, budget, depth + 1, requireFrozen);
    }
}

/**
 * Deep, recursive authority-shaped-key guard -- generalizes longhorizon's
 * original two-level-shallow check (projection + projection.selfModel
 * only) to arbitrary depth, since any future L2/L4/L6 projection shape
 * is not yet known and a shallow check would silently stop protecting
 * past whatever depth the ORIGINAL producer happened to nest fields at.
 */
function assertNoAuthorityShapedFields(value, label) {
    walkForAuthorityShapedFields(value, label, new WeakSet(), { count: 0 }, 0, false);
}

/**
 * Fail-closed mode normalizer -- the single place every governed-mode
 * consumer resolves a caller-supplied mode string. Anything not exactly
 * "off"/"shadow"/"governed" (including undefined, null, a revoked Proxy,
 * or a hostile object) resolves to "off".
 */
function resolveMode(mode) {
    try {
        return MODES.includes(mode) ? mode : "off";
    } catch {
        return "off";
    }
}

/**
 * ADR-17: shadow is decisionInfluence:false ALWAYS (zero influence by
 * contract, not merely by "no consumer exists yet"); governed is the
 * only mode where ADVISORY_ONLY influence is permitted. off never
 * reaches this (callers gate cycle-level work on mode==="off" earlier
 * and return before producing anything to check).
 */
function isInfluenceAllowed(mode) {
    return mode === "governed";
}

/**
 * Schema/shape check for a GovernedCognitiveProjection: correct
 * schemaVersion, decisionInfluence is exactly "ADVISORY_ONLY", frozen,
 * and carries no authority-shaped field at any depth. Throws a plain
 * Error with a clear reason on any violation; callers that need a
 * domain-coded failure should catch and re-fail with their own REASONS.
 */
function validateGovernedCognitiveProjection(projection) {
    try {
        if (!projection || typeof projection !== "object") {
            throw new Error("ACC governed: proyeksi wajib objek");
        }
        const schemaDescriptor = Object.getOwnPropertyDescriptor(projection, "schemaVersion");
        const influenceDescriptor = Object.getOwnPropertyDescriptor(projection, "decisionInfluence");
        if (!schemaDescriptor || !("value" in schemaDescriptor) ||
            !influenceDescriptor || !("value" in influenceDescriptor)) {
            throw new Error("ACC governed: proyeksi wajib berupa data properties");
        }
        if (schemaDescriptor.value !== "governedCognitiveProjection.v1") {
            throw new Error("ACC governed: schemaVersion proyeksi tidak dikenal");
        }
        if (influenceDescriptor.value !== "ADVISORY_ONLY") {
            throw new Error("ACC governed: decisionInfluence proyeksi wajib 'ADVISORY_ONLY'");
        }
        if (!Object.isFrozen(projection)) {
            throw new Error("ACC governed: proyeksi wajib dibekukan");
        }
        walkForAuthorityShapedFields(projection, "GovernedCognitiveProjection", new WeakSet(), { count: 0 }, 0, true);
        return true;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("ACC governed:")) throw error;
        throw new Error("ACC governed: proyeksi tidak dapat diverifikasi dengan aman (authProof/accessor boundary)");
    }
}

/**
 * Auditable mode transition (ADR-17: "a mode gate becomes a declared,
 * audited configuration transition"). Thin, fail-closed wrapper around
 * the same "audit failure never blocks cognition" pattern already used
 * by longhorizon's own auditSelfModelTransitions -- a missing/throwing/
 * revoked ledger never raises, it just means the transition goes
 * unaudited rather than crashing the caller.
 */
function recordModeTransition(options) {
    return recordModeTransitionChecked(options).event;
}

/**
 * Auditable mode transition with an explicit durability outcome.
 *
 * ADR-17 requires the mode gate to be a DECLARED, AUDITED configuration
 * transition. The previous implementation could not distinguish "audited"
 * from "silently went unaudited": a supplied ledger that was missing,
 * rejected, or threw produced exactly the same return value as a successful
 * append, so a caller could proceed in governed mode believing the
 * transition was recorded. Independent audit of 0b8abb7 flagged that as
 * fail-open.
 *
 * `recordModeTransitionChecked` never throws (the established "audit failure
 * must not take down the operation" law) but REPORTS the outcome so the
 * caller can fail closed on it:
 *   auditSupplied  -- a caller-supplied positive audit path existed
 *   audited        -- that path CONFIRMED a durable append
 *   failedOpen     -- a supplied path did NOT confirm; the caller must not
 *                     treat the transition as audited
 *
 * A missing ledger is a declared configuration (no positive audit claim is
 * made, `auditSupplied:false`), which is what keeps the Wave7 L7 convergence
 * contract's `mode: "governed"` construction -- with no ledger -- intact.
 * The fail-open case is specifically "you gave me a ledger and it did not
 * record", which is detectably different and must not be silently ignored.
 */
function recordModeTransitionChecked(options) {
    let auditLedger, from, to, at;
    try {
        const source = options && typeof options === "object" ? options : {};
        const read = (key) => {
            if (isProxyValue(source)) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(source, key);
            return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
        };
        auditLedger = read("auditLedger"); from = read("from"); to = read("to"); at = read("at");
    } catch {
        auditLedger = null; from = undefined; to = undefined; at = undefined;
    }
    const safeAt = typeof at === "number" && Number.isFinite(at) ? at : null;
    const event = Object.freeze({
        eventType: "cognition.governed.mode.transition",
        source: "acc.governed",
        outcome: "ok",
        metadata: Object.freeze({ from: resolveMode(from), to: resolveMode(to), at: safeAt })
    });

    let auditSupplied = false;
    let audited = false;
    try {
        const append = auditLedger && !isProxyValue(auditLedger) ? auditLedger.append : undefined;
        if (typeof append === "function") {
            auditSupplied = true;
            const result = append.call(auditLedger, event);
            if (result && typeof result.then === "function") {
                // Async ledgers cannot confirm durability here; treat as
                // unconfirmed rather than assuming success.
                Promise.resolve(result).catch(() => {});
            } else if (result && typeof result === "object" && "ok" in result) {
                audited = result.ok === true;      // appendSafe contract
            } else {
                audited = true;                    // canonical append() threw on failure
            }
        }
    } catch { /* audit failure never blocks cognition -- reported, not thrown */ }

    return { event, auditSupplied, audited, failedOpen: auditSupplied && !audited };
}

module.exports = Object.freeze({
    MODES,
    REASONS,
    GovernedError,
    fail,
    AUTHORITY_SHAPED_KEYS,
    assertNoAuthorityShapedFields,
    resolveMode,
    isInfluenceAllowed,
    validateGovernedCognitiveProjection,
    recordModeTransition,
    recordModeTransitionChecked
});
