"use strict";

/**
 * Shared deterministic fake providers and system factory for recovery tests.
 * These fakes are ATTACK SURFACES ON PURPOSE: they let tests inject
 * failures, hostile data, and observe prepare/commit ordering.
 */

const {
    defineRecoveryProvider,
    ProviderRegistry
} = require("../../../src/runtime/recovery/provider");
const { resolveRecoveryConfig } = require("../../../src/runtime/recovery/config");
const { RecoveryStore, CheckpointBuilder } = require("../../../src/runtime/recovery/checkpoint");
const ids = require("../../../src/runtime/recovery/ids");

/**
 * @param {object} overrides static spec fields (id, schemaVersion,
 *   classification, required, data) plus optional capture().
 * Returns a frozen provider whose `__state` records every lifecycle call.
 */
function makeFakeProvider(overrides = {}) {
    const state = {
        captured: 0,
        prepared: [],
        committed: [],
        aborted: [],
        rolledBack: [],
        captureThrows: null,
        validateRejects: null,
        prepareFailOn: new Set(),
        commitFailOn: new Set(),
        noRollback: false,
        ...(overrides.__state ?? {})
    };
    const spec = {
        id: "fake",
        schemaVersion: 1,
        classification: "INTERNAL_STATE",
        required: true,
        data: { ok: true },
        ...overrides
    };

    const provider = defineRecoveryProvider({
        id: spec.id,
        schemaVersion: spec.schemaVersion,
        classification: spec.classification,
        required: spec.required,
        capture() {
            state.captured += 1;
            if (state.captureThrows) {
                throw state.captureThrows;
            }
            if (typeof spec.capture === "function") {
                return spec.capture();
            }
            return spec.data;
        },
        validateSection() {
            if (state.validateRejects) {
                return { ok: false, message: String(state.validateRejects) };
            }
            return true;
        },
        async prepareRestore(data) {
            if (state.prepareFailOn.has("any") || state.prepareFailOn.has(state.prepared.length + 1)) {
                throw new Error(`injected prepare failure for ${spec.id}`);
            }
            const handle = { sectionId: spec.id, data, seq: state.prepared.length + 1 };
            state.prepared.push(handle);
            return handle;
        },
        async commitRestore(handle) {
            if (state.commitFailOn.has("any") || state.commitFailOn.has(state.committed.length + 1)) {
                throw new Error(`injected commit failure for ${spec.id}`);
            }
            state.committed.push(handle.sectionId);
        },
        abortRestore(handle) {
            state.aborted.push(handle.sectionId);
        },
        rollbackRestore(handle) {
            if (state.noRollback) {
                throw new Error("no rollback available");
            }
            state.rolledBack.push(handle.sectionId);
        }
    });

    return Object.freeze(Object.assign({}, provider, { __state: state }));
}

function makeSystem(configOverrides) {
    const config = resolveRecoveryConfig(configOverrides);
    const registry = new ProviderRegistry(config.maxProviderCount);
    const store = new RecoveryStore(config, registry);
    return {
        config,
        registry,
        store,
        generationLedger: { current: ids.newRuntimeGenerationId() }
    };
}

async function checkpointOnce(system, { faults = [], reason = "TEST" } = {}) {
    const builder = new CheckpointBuilder(system);
    return builder.run({
        reason,
        runtimeGenerationId: system.generationLedger.current,
        faults
    });
}

module.exports = {
    makeFakeProvider,
    makeSystem,
    checkpointOnce,
    newRuntimeGenerationId: ids.newRuntimeGenerationId
};
