"use strict";

/**
 * CAPABILITY REGISTRY V1 — closed registrar / provenance trust model.
 *
 * Provenance identity is NOT caller-asserted. It originates from a registrar
 * instance that the runtime creates once, that owns an immutable provenance
 * identity, and that is the only channel for canonical admission.
 *
 *   Runtime creates registrar
 *          ↓
 *   registrar owns immutable provenance identity (domain + registrar id)
 *          ↓
 *   registrar.register(descriptor)
 *          ↓
 *   private CapabilityRegistry admission
 *
 * A registrar's provenance identity cannot be modified or selected by the
 * descriptor being registered, and cannot be self-selected by an arbitrary
 * caller passing strings. This is IDENTITY only — it carries NO authorization,
 * authority, or permission semantics.
 *
 * Closed domains:
 *   core      → provenance "core/runtime"        (trusted runtime only)
 *   extension → provenance "extension:<id>"
 *   device    → provenance "device:<id>"
 *   provider  → provenance "provider:<id>"
 */

const { fail, REASONS } = require("./errors");
const { canonicalProvenance, canonicalCapabilityId } = require("./ids");
const { KINDS } = require("./kinds");

const REGISTRAR_DOMAINS = Object.freeze({
    CORE: "core",
    EXTENSION: "extension",
    DEVICE: "device",
    PROVIDER: "provider"
});

const DOMAIN_SET = Object.freeze(new Set(Object.values(REGISTRAR_DOMAINS)));

/**
 * Kind/provenance correspondence. A registrar may only admit capabilities of
 * the kinds that legitimately originate from its provenance domain.
 */
const ALLOWED_KINDS_BY_DOMAIN = Object.freeze({
    core: Object.freeze([KINDS.SYSTEM, KINDS.RUNTIME, KINDS.TOOL]),
    extension: Object.freeze([KINDS.EXTENSION]),
    device: Object.freeze([KINDS.DEVICE]),
    provider: Object.freeze([KINDS.PROVIDER, KINDS.TOOL])
});

/**
 * Derive the immutable authoritative provenance from a registrar domain and
 * (for non-core domains) a registrar id. The result is canonicalized and
 * validated; authority-shaped tokens are rejected by canonicalProvenance.
 */
function deriveProvenance(domain, registrarId) {
    if (typeof domain !== "string" || !DOMAIN_SET.has(domain)) {
        throw fail(REASONS.INVALID_REGISTRAR,
            `registrar domain '${String(domain).slice(0, 64)}' is not a recognized trust domain`,
            { received: String(domain).slice(0, 64), allowed: [...DOMAIN_SET] });
    }
    if (domain === REGISTRAR_DOMAINS.CORE) {
        return canonicalProvenance("core/runtime");
    }
    if (typeof registrarId !== "string" || !registrarId.trim()) {
        throw fail(REASONS.INVALID_REGISTRAR,
            `registrar domain '${domain}' requires a non-empty registrar id`);
    }
    // canonicalCapabilityId validates the id grammar (lowercase, bounded,
    // no reserved/path/whitespace segments); canonicalProvenance additionally
    // rejects authority-shaped tokens at any segment.
    const canonicalId = canonicalCapabilityId(registrarId);
    return canonicalProvenance(`${domain}:${canonicalId}`);
}

/** Return the immutable set of kinds a registrar of `domain` may admit. */
function allowedKindsForDomain(domain) {
    if (typeof domain !== "string" || !DOMAIN_SET.has(domain)) {
        throw fail(REASONS.INVALID_REGISTRAR,
            `registrar domain '${String(domain).slice(0, 64)}' is not recognized`);
    }
    return ALLOWED_KINDS_BY_DOMAIN[domain];
}

/** Validate that a descriptor kind corresponds to a registrar domain. */
function assertKindDomainCorrespondence(kind, domain) {
    const allowed = allowedKindsForDomain(domain);
    if (!allowed.includes(kind)) {
        throw fail(REASONS.KIND_PROVENANCE_MISMATCH,
            `kind '${kind}' cannot be registered from provenance domain '${domain}'`,
            { kind, domain, allowed });
    }
}

/**
 * Create a registrar bound to a registry's private admission function.
 *
 * The registrar is an opaque, frozen object. Its provenance identity is
 * computed once (from runtime-owned domain + registrar id) and is immutable.
 * It exposes two boundaries:
 *
 *   register(serialized)    — UNTRUSTED boundary: accepts bounded serialized
 *                             JSON (string / Uint8Array) only. Arbitrary JS
 *                             objects are rejected (they can carry Proxies
 *                             whose ownKeys/getOwnPropertyDescriptor traps
 *                             execute during traversal).
 *   registerCanonical(obj)  — TRUSTED / INTERNAL boundary: accepts an
 *                             already-canonical plain descriptor produced by
 *                             trusted runtime code (e.g. certified manifest
 *                             adapters). Must never be fed hostile input.
 */
function createRegistrar(admit, { domain, registrarId }) {
    if (typeof admit !== "function") {
        throw fail(REASONS.INVALID_REGISTRAR, "registrar requires a private admission function");
    }
    const provenance = deriveProvenance(domain, registrarId);

    return Object.freeze({
        domain: Object.freeze(domain),
        provenance: Object.freeze(provenance),

        register(descriptorInput) {
            return admit(descriptorInput, provenance, { serializedOnly: true });
        },

        registerCanonical(descriptorInput) {
            return admit(descriptorInput, provenance, { serializedOnly: false });
        }
    });
}

module.exports = {
    REGISTRAR_DOMAINS,
    DOMAIN_SET,
    ALLOWED_KINDS_BY_DOMAIN,
    deriveProvenance,
    allowedKindsForDomain,
    assertKindDomainCorrespondence,
    createRegistrar
};
