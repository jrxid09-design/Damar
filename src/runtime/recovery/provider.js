"use strict";

const { coerceSectionId } = require("./ids");
const { isClassification, SECTION_CLASSIFICATION } = require("./classification");

/**
 * RecoveryProvider contract (R3).
 *
 * Providers are inert adapters owned by their subsystems. Recovery never
 * imports subsystem internals; providers are registered explicitly in
 * code. Provider ids coming from serialized capsule data are only ever
 * looked up in the explicit registry — never used for dynamic require.
 *
 * Contract:
 *   id              : valid RecoverySectionId
 *   schemaVersion   : positive integer
 *   classification  : SECTION_CLASSIFICATION value
 *   required        : boolean — REQUIRED vs OPTIONAL section (R11)
 *   capture(ctx)            -> plain serializable data (or null to abstain)
 *   validateSection(data)   -> true | { ok:false, message }
 *   prepareRestore(data,ctx)-> detached prepared handle
 *   commitRestore(handle)   -> void | throws
 *   abortRestore?(handle)   -> void  (release prepared state)
 *   rollbackRestore?(handle)-> void  (compensate committed state)
 */
function defineRecoveryProvider(spec) {
    if (typeof spec !== "object" || spec === null) {
        throw new TypeError("provider spec must be an object");
    }
    const id = coerceSectionId(spec.id);
    if (!Number.isSafeInteger(spec.schemaVersion) || spec.schemaVersion < 1) {
        throw new TypeError(`provider ${id}: schemaVersion must be a positive integer`);
    }
    if (!isClassification(spec.classification)) {
        throw new TypeError(`provider ${id}: unknown classification`);
    }
    if (typeof spec.required !== "boolean") {
        throw new TypeError(`provider ${id}: required must be boolean`);
    }
    for (const fn of ["capture", "validateSection", "prepareRestore", "commitRestore"]) {
        if (typeof spec[fn] !== "function") {
            throw new TypeError(`provider ${id}: missing function ${fn}`);
        }
    }
    return Object.freeze({
        id,
        schemaVersion: spec.schemaVersion,
        classification: spec.classification,
        required: spec.required,
        capture: spec.capture,
        validateSection: spec.validateSection,
        prepareRestore: spec.prepareRestore,
        commitRestore: spec.commitRestore,
        abortRestore: typeof spec.abortRestore === "function" ? spec.abortRestore : null,
        rollbackRestore: typeof spec.rollbackRestore === "function" ? spec.rollbackRestore : null
    });
}

class ProviderRegistry {
    constructor(maxProviderCount) {
        this.maxProviderCount = maxProviderCount;
        this.providers = new Map();
    }

    register(provider) {
        const p = provider && provider.id ? provider : defineRecoveryProvider(provider);
        if (this.providers.has(p.id)) {
            throw new RangeError(`provider already registered: ${p.id}`);
        }
        if (this.providers.size >= this.maxProviderCount) {
            throw new RangeError("provider count exceeds configured bound");
        }
        this.providers.set(p.id, p);
        return p;
    }

    get(id) {
        return this.providers.get(id) ?? null;
    }

    /** Explicit lookup only. Serialized input can never create a provider. */
    lookupFromSerialized(id) {
        return this.providers.get(id) ?? null;
    }

    list() {
        return Object.freeze([...this.providers.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));
    }
}

module.exports = Object.freeze({
    defineRecoveryProvider,
    ProviderRegistry
});
