"use strict";

const { resolveRecoveryConfig } = require("./config");
const { ProviderRegistry } = require("./provider");
const { DiagnosticCollector } = require("./diagnostics");
const { CAPSULE_STATUS, CHECKPOINT_REASONS, buildManifestMaterial } = require("./manifest");
const { canonicalBytes } = require("./canonicalJson");
const { sha256Hex } = require("./digest");
const { validateCapsule } = require("./validation");
const {
    newRecoveryCapsuleId,
    coerceRecoveryCapsuleId,
    coerceRuntimeGenerationId,
    newRecoveryEpochId,
    epochRank
} = require("./ids");
const { isCheckpointable } = require("./classification");

/**
 * Checkpoint transaction (R7/R8).
 *
 * Write model:
 *   capture all -> validate all -> canonicalize all ->
 *   build the complete capsule in memory -> single atomic store.commit()
 *
 * The store only ever accepts a fully-formed COMPLETE capsule that passes
 * full re-validation at commit time. A crash at ANY earlier point leaves
 * zero capsules behind — a half-built builder is discarded as INVALID and
 * was never visible to any reader. No valid-looking half-capsule can exist.
 */

class RecoveryFault extends Error {
    constructor(point) {
        super(`injected recovery fault: ${point}`);
        this.name = "RecoveryFault";
        this.faultPoint = point;
    }
}

class RecoveryCheckpointAborted extends Error {
    constructor(diagnostics, cause) {
        super("checkpoint aborted before atomic commit; no capsule persisted");
        this.name = "RecoveryCheckpointAborted";
        this.diagnostics = diagnostics;
        this.cause = cause;
    }
}

class RecoveryEpochAllocator {
    constructor() {
        this.counter = 0n;
    }

    next() {
        this.counter += 1n;
        return newRecoveryEpochId(Number(this.counter));
    }
}

class RecoveryStore {
    constructor(config, registry) {
        this.config = config;
        this.registry = registry;
        this.capsules = new Map();
        this.epochAllocator = new RecoveryEpochAllocator();
        this.commitLog = Object.freeze([]);
    }

    /**
     * Atomic commit point. Either the whole validated capsule becomes
     * visible or nothing does. Re-validates the wire form so even an
     * in-memory caller cannot bypass integrity checks.
     */
    commit(wire) {
        const verdict = validateCapsule(wire, this.registry, this.config);
        if (!verdict.ok) {
            const err = new RangeError("capsule failed commit-time validation");
            err.diagnostics = verdict.diagnostics;
            throw err;
        }
        const id = verdict.capsuleId;
        if (this.capsules.has(id)) {
            throw new RangeError(`duplicate capsule id: ${id}`);
        }
        for (const existing of this.capsules.values()) {
            if (existing.manifest.epochId === wire.manifest.epochId) {
                throw new RangeError(
                    `epoch ${wire.manifest.epochId} already owned by capsule ${existing.manifest.capsuleId}`
                );
            }
        }
        const frozen = deepFreezeCapsule(wire);
        this.capsules.set(id, frozen);
        this.commitLog = Object.freeze([...this.commitLog, id]);
        return frozen;
    }

    allocateEpoch() {
        return this.epochAllocator.next();
    }

    get(capsuleId) {
        return this.capsules.get(coerceRecoveryCapsuleId(capsuleId)) ?? null;
    }

    /** Deterministic candidate list, newest epoch first. */
    candidates(maxCount) {
        const limit = maxCount ?? this.config.maxCandidateCapsules;
        const sorted = [...this.capsules.values()].sort((a, b) => {
            const r = epochRank(b.manifest.epochId) - epochRank(a.manifest.epochId);
            if (r !== 0) return r;
            return a.manifest.capsuleId < b.manifest.capsuleId ? -1 : 1;
        });
        return Object.freeze(sorted.slice(0, limit));
    }

    get size() {
        return this.capsules.size;
    }
}

const EMPTY_REGISTRY = new ProviderRegistry(Number.MAX_SAFE_INTEGER);

function deepFreezeCapsule(wire) {
    const sections = {};
    for (const [k, v] of Object.entries(wire.sections)) {
        sections[k] = Object.freeze({ schemaVersion: v.schemaVersion, data: v.data });
    }
    return Object.freeze({
        manifest: Object.freeze({ ...wire.manifest, sections: wire.manifest.sections.map(Object.freeze) }),
        sections: Object.freeze(sections)
    });
}

class CheckpointBuilder {
    /**
     * @param {object} opts
     * @param {ProviderRegistry} opts.registry
     * @param {RecoveryStore} opts.store
     * @param {object} [opts.config]
     */
    constructor({ registry, store, config }) {
        this.registry = registry;
        this.store = store;
        this.config = config ?? store.config;
        this.status = CAPSULE_STATUS.BUILDING;
        this.collector = new DiagnosticCollector(this.config.maxDiagnostics);
        this.resultCapsuleId = null;
    }

    maybeFault(faults, point) {
        if (faults && faults.includes(point)) {
            throw new RecoveryFault(point);
        }
    }

    /**
     * Run the full checkpoint transaction.
     * @param {object} opts
     * @param {string} opts.reason one of CHECKPOINT_REASONS
     * @param {string} opts.runtimeGenerationId
     * @param {string|null} [opts.parentCapsuleId]
     * @param {string[]} [opts.faults] injected crash points for tests
     */
    async run({ reason, runtimeGenerationId, parentCapsuleId = null, faults = [] }) {
        try {
            return await this._run({ reason, runtimeGenerationId, parentCapsuleId, faults });
        } catch (err) {
            this.status = this.status === CAPSULE_STATUS.COMPLETE ? CAPSULE_STATUS.COMPLETE : CAPSULE_STATUS.INVALID;
            if (!(err instanceof RecoveryFault) && !(err instanceof RecoveryCheckpointAborted)) {
                this.collector.add("CHECKPOINT_ABORTED", { message: err.message?.slice(0, 256) });
            }
            throw new RecoveryCheckpointAborted(this.collector.snapshot(), err);
        }
    }

    async _run({ reason, runtimeGenerationId, parentCapsuleId, faults }) {
        if (!CHECKPOINT_REASONS.includes(reason)) {
            throw new RangeError(`unknown checkpoint reason: ${reason}`);
        }
        const generationId = coerceRuntimeGenerationId(runtimeGenerationId);
        if (parentCapsuleId !== null) {
            coerceRecoveryCapsuleId(parentCapsuleId);
        }

        const capturedSections = [];
        for (const provider of this.registry.list()) {
            if (!isCheckpointable(provider.classification, this.config)) {
                this.collector.add("EPHEMERAL_SECTION_SKIPPED", { sectionId: provider.id });
                continue;
            }

            this.maybeFault(faults, "before-capture");
            let data;
            try {
                data = await provider.capture({});
            } catch (err) {
                this.collector.add("PREPARE_FAILED", { sectionId: provider.id, message: "capture failed" });
                throw err;
            }
            this.maybeFault(faults, `during-capture:${provider.id}`);

            if (capturedSections.some((s) => s.sectionId === provider.id)) {
                throw new RangeError("duplicate section capture");
            }
            if (data === null || data === undefined) {
                continue;
            }
            const payload = { schemaVersion: provider.schemaVersion, data };
            const bytes = canonicalBytes(payload);
            if (bytes.byteLength > this.config.maxSectionBytes) {
                this.collector.add("SECTION_TOO_LARGE", { sectionId: provider.id });
                throw new RangeError(`section ${provider.id} exceeds size bound`);
            }
            capturedSections.push({
                sectionId: provider.id,
                schemaVersion: provider.schemaVersion,
                classification: provider.classification,
                required: provider.required,
                byteLength: bytes.byteLength,
                digest: sha256Hex(bytes),
                payload
            });
            this.maybeFault(faults, `after-capture:${provider.id}`);
        }

        if (capturedSections.length > this.config.maxSections) {
            this.collector.add("TOO_MANY_SECTIONS", {});
            throw new RangeError("too many sections");
        }

        this.maybeFault(faults, "before-manifest");

        const sorted = [...capturedSections].sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1));
        const manifestSections = sorted.map(({ payload, ...meta }) => meta);
        const material = buildManifestMaterial({
            capsuleId: newRecoveryCapsuleId(),
            parentCapsuleId,
            epochId: this.store.allocateEpoch(),
            runtimeGenerationId: generationId,
            createdAtMs: Date.now(),
            reason,
            status: CAPSULE_STATUS.COMPLETE,
            sections: manifestSections
        });
        material.manifestDigest = sha256Hex(canonicalBytes(material));

        const wire = { manifest: material, sections: {} };
        for (const s of sorted) {
            wire.sections[s.sectionId] = s.payload;
        }

        this.maybeFault(faults, "before-commit");

        // Whole-capsule canonical size bound (manifest + all sections),
        // computed over the exact bytes that would become durable.
        const totalBytes = canonicalBytes(wire).byteLength;
        if (totalBytes > this.config.maxCapsuleBytes) {
            this.collector.add("CAPSULE_TOO_LARGE", { message: `canonical capsule is ${totalBytes} bytes` });
            throw new RangeError("capsule exceeds maxCapsuleBytes");
        }

        // Single atomic visibility point.
        const stored = this.store.commit(wire);
        this.status = CAPSULE_STATUS.COMPLETE;
        this.resultCapsuleId = stored.manifest.capsuleId;
        return stored;
    }
}

module.exports = Object.freeze({
    RecoveryFault,
    RecoveryCheckpointAborted,
    RecoveryEpochAllocator,
    RecoveryStore,
    CheckpointBuilder,
    createRecoverySystem(configOverrides) {
        const config = resolveRecoveryConfig(configOverrides);
        const registry = new ProviderRegistry(config.maxProviderCount);
        const store = new RecoveryStore(config, registry);
        return { config, registry, store };
    }
});
