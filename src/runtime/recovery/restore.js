"use strict";

const { DiagnosticCollector } = require("./diagnostics");
const { isAutoRestorable } = require("./classification");

/**
 * Restore transaction (R12) — two-phase, all-or-nothing.
 *
 * Phase PREPARE: every restorable section is prepared in canonical
 * section order. A detached prepared handle is produced. If ANY prepare
 * fails, all prepared handles are aborted and nothing was restored.
 *
 * Phase COMMIT: prepared handles are committed in the same order. If a
 * commit fails at provider N, providers 1..N-1 are rolled back in reverse
 * order using their compensating rollbackRestore (or abortRestore).
 *
 * NON_RESUMABLE sections never enter either phase; AUTHORITY_SENSITIVE
 * sections are only surfaced as opaque evidence requiring revalidation.
 */
const RESTORE_OUTCOMES = Object.freeze({
    RESTORED: "RESTORED",
    FAILED_PREPARE: "FAILED_PREPARE",
    FAILED_COMMIT: "FAILED_COMMIT"
});

async function executeRestore(decision, capsule, registry, ctx = {}) {
    const diags = new DiagnosticCollector(ctx.maxDiagnostics ?? 200);
    const m = capsule.manifest;
    const prepared = [];
    const committed = [];

    if (!decision || decision.capsuleId !== m.capsuleId || decision.outcome === "REFUSE") {
        return refuse(diags);
    }

    for (const entry of m.sections) {
        if (!isAutoRestorable(entry.classification)) {
            continue;
        }
        const provider = registry.lookupFromSerialized(entry.sectionId);
        const payload = capsule.sections[entry.sectionId];
        if (!provider || !payload) {
            return failPrepare(diags, prepared, entry.sectionId, "provider or payload missing");
        }
        let handle;
        try {
            handle = await provider.prepareRestore(payload.data, ctx);
            prepared.push({ provider, handle });
        } catch (err) {
            await abortAll(prepared);
            diags.add("PREPARE_FAILED", { sectionId: entry.sectionId, message: err.message?.slice(0, 256) });
            return freeze({
                outcome: RESTORE_OUTCOMES.FAILED_PREPARE,
                capsuleId: m.capsuleId,
                failedSectionId: entry.sectionId,
                committedSections: [],
                rolledBackSections: [],
                diagnostics: diags.snapshot()
            });
        }
    }

    for (const { provider, handle } of prepared) {
        try {
            await provider.commitRestore(handle, ctx);
            committed.push(provider.id);
        } catch (err) {
            diags.add("COMMIT_FAILED", { sectionId: provider.id, message: err.message?.slice(0, 256) });
            const rolledBack = await rollbackCommitted(prepared, committed, diags);
            return freeze({
                outcome: RESTORE_OUTCOMES.FAILED_COMMIT,
                capsuleId: m.capsuleId,
                failedSectionId: provider.id,
                committedSections: [],
                rolledBackSections: Object.freeze(rolledBack),
                diagnostics: diags.snapshot()
            });
        }
    }

    if (decision.requiresAuthorityRevalidation) {
        diags.add("AUTHORITY_REVALIDATION_REQUIRED", { capsuleId: m.capsuleId });
    }
    return freeze({
        outcome: RESTORE_OUTCOMES.RESTORED,
        capsuleId: m.capsuleId,
        failedSectionId: null,
        committedSections: Object.freeze(committed.slice().sort()),
        rolledBackSections: Object.freeze([]),
        deferredSections: decision.deferredSections,
        requiresAuthorityRevalidation: decision.requiresAuthorityRevalidation,
        runtimeGenerationId: ctx.runtimeGenerationId ?? null,
        note: "Recovered belief is NOT freshly verified reality; external state must be re-observed before actuation.",
        diagnostics: diags.snapshot()
    });
}

async function abortAll(preparedList) {
    for (const { provider, handle } of [...preparedList].reverse()) {
        if (provider.abortRestore) {
            try {
                await provider.abortRestore(handle);
            } catch {
                // abort best-effort; recorded by caller diagnostics where possible
            }
        }
    }
}

async function rollbackCommitted(prepared, committedIds, diags) {
    const rolledBack = [];
    for (const { provider, handle } of [...prepared].reverse()) {
        if (!committedIds.includes(provider.id)) {
            continue;
        }
        const undo = provider.rollbackRestore ?? provider.abortRestore;
        if (!undo) {
            diags.add("ROLLBACK_FAILED", { sectionId: provider.id, message: "no compensation defined" });
            continue;
        }
        try {
            await undo.call(provider, handle);
            rolledBack.push(provider.id);
        } catch (err) {
            diags.add("ROLLBACK_FAILED", { sectionId: provider.id, message: err.message?.slice(0, 256) });
        }
    }
    return rolledBack.sort();
}

function refuse(collector) {
    collector.add("UNKNOWN", { message: "restore invoked with refused or mismatched decision" });
    return Object.freeze({
        outcome: RESTORE_OUTCOMES.FAILED_PREPARE,
        capsuleId: null,
        failedSectionId: null,
        committedSections: Object.freeze([]),
        rolledBackSections: Object.freeze([]),
        diagnostics: collector.snapshot()
    });
}

function freeze(record) {
    return Object.freeze(record);
}

module.exports = Object.freeze({ RESTORE_OUTCOMES, executeRestore });
