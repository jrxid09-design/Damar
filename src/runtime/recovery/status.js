"use strict";

/**
 * Recovery status (R26) — immutable read-only view for future observers
 * (Observatory, /status, Presence, watchdog). Never exposes raw section
 * data. Diagnostics are bounded and sanitized.
 */
class RecoveryStatusTracker {
    constructor(maxDiagnostics) {
        this.maxDiagnostics = maxDiagnostics;
        this.lastCompleteCapsuleId = null;
        this.lastEpoch = null;
        this.candidateCount = 0;
        this.currentRuntimeGeneration = null;
        this.lastDecision = null;
        this.diagnostics = [];
    }

    recordCheckpoint(capsule) {
        this.lastCompleteCapsuleId = capsule.manifest.capsuleId;
        this.lastEpoch = capsule.manifest.epochId;
        return this.getRecoveryStatus();
    }

    recordCandidates(count) {
        this.candidateCount = Math.max(0, Math.min(count | 0, Number.MAX_SAFE_INTEGER));
        return this.getRecoveryStatus();
    }

    recordDecision(decision) {
        this.lastDecision = decision
            ? {
                outcome: decision.outcome,
                capsuleId: decision.capsuleId,
                epoch: decision.epoch,
                reasonCodes: decision.reasonCodes,
                degradedSections: decision.degradedSections
            }
            : null;
        if (decision && Array.isArray(decision.diagnostics)) {
            this.pushDiagnostics(decision.diagnostics);
        }
        return this.getRecoveryStatus();
    }

    recordRuntimeGeneration(generationId) {
        this.currentRuntimeGeneration = generationId ?? null;
        return this.getRecoveryStatus();
    }

    pushDiagnostics(diags) {
        for (const d of diags.slice(-this.maxDiagnostics)) {
            this.diagnostics.push(d);
        }
        if (this.diagnostics.length > this.maxDiagnostics) {
            this.diagnostics = this.diagnostics.slice(-this.maxDiagnostics);
        }
    }

    getRecoveryStatus() {
        return Object.freeze({
            lastCompleteCapsuleId: this.lastCompleteCapsuleId,
            lastEpoch: this.lastEpoch,
            candidateCount: this.candidateCount,
            currentRuntimeGeneration: this.currentRuntimeGeneration,
            lastDecision: this.lastDecision ? Object.freeze({ ...this.lastDecision }) : null,
            degraded:
                this.lastDecision?.outcome === "DEGRADED_RESTORE",
            diagnostics: Object.freeze([...this.diagnostics])
        });
    }
}

module.exports = Object.freeze({ RecoveryStatusTracker });
