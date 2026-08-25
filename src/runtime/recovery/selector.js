"use strict";

const { DiagnosticCollector, createDiagnostic } = require("./diagnostics");
const { analyzeLineage } = require("./lineage");
const { validateCapsule } = require("./validation");
const { epochRank } = require("./ids");
const { SECTION_CLASSIFICATION, isAutoRestorable } = require("./classification");

/**
 * Recovery selection (R9/R10/R11/R17).
 *
 * Deterministic evaluation of candidate capsules. No LLM/model judgment,
 * no "pick latest file and trust it": without an explicit capsule id the
 * selector refuses unless an explicit newest-wins policy was passed.
 *
 * Outcomes:
 *   RESTORE           — all required sections present and supported
 *   DEGRADED_RESTORE  — some OPTIONAL sections missing/unsupported
 *   REFUSE            — fail closed, with exact reason codes
 */
const DECISION_OUTCOMES = Object.freeze({
    RESTORE: "RESTORE",
    DEGRADED_RESTORE: "DEGRADED_RESTORE",
    REFUSE: "REFUSE"
});

function decide({ candidates, registry, config, requestedCapsuleId = null, policy = "EXPLICIT_ONLY" }) {
    const diags = new DiagnosticCollector(config.maxDiagnostics);

    if (!Array.isArray(candidates)) {
        return refuse(diags, "SELECTION_AMBIGUOUS", { message: "candidates must be an array" });
    }
    const bounded = candidates.slice(0, config.maxCandidateCapsules);
    if (candidates.length > config.maxCandidateCapsules) {
        diags.add("CAPSULE_TOO_LARGE", { message: "candidate count exceeded bound; excess ignored" });
    }

    // Determinism (R22): canonical order independent of arrival order.
    const sorted = [...bounded].sort((a, b) => {
        const r = epochRank(b.manifest.epochId) - epochRank(a.manifest.epochId);
        if (r !== 0) return r;
        return a.manifest.capsuleId < b.manifest.capsuleId ? -1 : 1;
    });

    let chosen = null;
    if (requestedCapsuleId !== null) {
        chosen = sorted.find((c) => c.manifest.capsuleId === requestedCapsuleId);
        if (!chosen) {
            return refuse(diags, "EXPLICIT_SELECTION_NOT_FOUND", { capsuleId: requestedCapsuleId });
        }
    } else if (policy === "NEWEST_VALID") {
        for (const c of sorted) {
            const v = validateCapsule(c, registry, config);
            if (v.ok) {
                chosen = c;
                break;
            }
        }
        if (!chosen) {
            return refuse(diags, "INCOMPLETE_CAPSULE", { message: "no valid candidate under NEWEST_VALID" });
        }
    } else {
        return refuse(diags, "SELECTION_AMBIGUOUS", {
            message: "no explicit capsule selected; implicit newest-wins is not trusted"
        });
    }

    const verdict = validateCapsule(chosen, registry, config);
    if (!verdict.ok || !verdict.manifest) {
        for (const d of verdict.diagnostics) {
            diags.add(d.code, d);
        }
        if (verdict.incompatible) {
            return refuse(diags, "UNSUPPORTED_VERSION", { capsuleId: chosen.manifest.capsuleId });
        }
        if (diags.items.some((d) => d.code === "INCOMPLETE_CAPSULE")) {
            return refuse(diags, "INCOMPLETE_CAPSULE", { capsuleId: chosen.manifest.capsuleId });
        }
        return refuse(diags, "UNKNOWN", { capsuleId: chosen.manifest.capsuleId });
    }

    const lineage = analyzeLineage(bounded, config);
    for (const d of lineage.diagnostics) {
        diags.add(d.code, d);
    }
    if (lineage.hasCycle) {
        return refuse(diags, "LINEAGE_CYCLE", { capsuleId: chosen.manifest.capsuleId });
    }

    const m = verdict.manifest;
    const missingRequired = [];
    const degradedSections = [];
    const deferredSections = [];
    let requiresAuthorityRevalidation = false;
    const supportedSectionIds = new Set();

    for (const entry of m.sections) {
        supportedSectionIds.add(entry.sectionId);
        if (entry.classification === SECTION_CLASSIFICATION.AUTHORITY_SENSITIVE) {
            requiresAuthorityRevalidation = true;
        }
        if (!isAutoRestorable(entry.classification)) {
            deferredSections.push({
                sectionId: entry.sectionId,
                status: entry.classification === SECTION_CLASSIFICATION.NON_RESUMABLE
                    ? "INTERRUPTED"
                    : "REQUIRES_REVALIDATION"
            });
        }
    }

    for (const provider of registry.list()) {
        // EPHEMERAL providers are expected to be absent from capsules;
        // their absence is never a degradation.
        if (provider.classification === SECTION_CLASSIFICATION.EPHEMERAL) {
            continue;
        }
        const present = supportedSectionIds.has(provider.id);
        const entry = m.sections.find((s) => s.sectionId === provider.id) ?? null;
        if (!present) {
            if (provider.required) {
                missingRequired.push(provider.id);
            } else {
                degradedSections.push(provider.id);
            }
            continue;
        }
        if (entry.schemaVersion !== provider.schemaVersion && provider.required) {
            missingRequired.push(provider.id);
        } else if (entry.schemaVersion !== provider.schemaVersion) {
            degradedSections.push(provider.id);
        }
    }

    if (missingRequired.length > 0) {
        return refuse(diags, "MISSING_REQUIRED_SECTION", {
            capsuleId: m.capsuleId,
            message: `missing required sections: ${missingRequired.sort().join(",")}`
        });
    }

    const outcome = degradedSections.length > 0 ? DECISION_OUTCOMES.DEGRADED_RESTORE : DECISION_OUTCOMES.RESTORE;
    const reasonCodes = [];
    if (outcome === DECISION_OUTCOMES.DEGRADED_RESTORE) {
        reasonCodes.push("DEGRADED_MISSING_OPTIONAL_SECTIONS");
    }
    if (requiresAuthorityRevalidation) {
        reasonCodes.push("AUTHORITY_REVALIDATION_REQUIRED");
        diags.add("AUTHORITY_REVALIDATION_REQUIRED", { capsuleId: m.capsuleId });
    }
    if (deferredSections.length > 0) {
        reasonCodes.push("NON_RESUMABLE_STATE_DEFERRED");
    }

    return Object.freeze({
        outcome,
        capsuleId: m.capsuleId,
        epoch: m.epochId,
        runtimeGenerationId: m.runtimeGenerationId,
        reasonCodes: Object.freeze(reasonCodes),
        degradedSections: Object.freeze(degradedSections.slice().sort()),
        deferredSections: Object.freeze(
            deferredSections.slice().sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1))
        ),
        requiresAuthorityRevalidation,
        diagnostics: diags.snapshot()
    });
}

function refuse(collector, code, details) {
    collector.add(code, details);
    return Object.freeze({
        outcome: DECISION_OUTCOMES.REFUSE,
        capsuleId: details?.capsuleId ?? null,
        epoch: null,
        runtimeGenerationId: null,
        reasonCodes: Object.freeze([code]),
        degradedSections: Object.freeze([]),
        deferredSections: Object.freeze([]),
        requiresAuthorityRevalidation: false,
        diagnostics: collector.snapshot()
    });
}

module.exports = Object.freeze({
    DECISION_OUTCOMES,
    decide,
    createDiagnostic
});
