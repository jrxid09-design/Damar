"use strict";

const HEALTH_RANK = Object.freeze({ HEALTHY: 3, DEGRADED: 2, CRITICAL: 1 });

// RT-W10-59: proof requires ledger-backed evidence
// RT-W10-56: exactly one workspace must be reachable
// RT-W10-57: exactly one self-model after any swap
// RT-W10-60: whole-system health is the minimum across all lanes
function makeConvergenceProof(artifacts) {
    if (!artifacts) throw new Error("artifacts required for convergence proof (W10-L7/RT-W10-59)");

    // RT-W10-59: ledger reference is mandatory
    if (!artifacts.ledgerRef) {
        throw new Error(
            "Convergence proof requires ledger-backed artifacts — no ledgerRef provided (W10-L7/RT-W10-59)"
        );
    }

    // RT-W10-56: single workspace instance
    if (artifacts.workspaceCount !== undefined && artifacts.workspaceCount !== 1) {
        throw new Error(
            `Convergence proof failed: multiple workspaces detected (count=${artifacts.workspaceCount}) (W10-L7/RT-W10-56)`
        );
    }

    // RT-W10-57: single self-model instance
    if (artifacts.selfModelCount !== undefined && artifacts.selfModelCount !== 1) {
        throw new Error(
            `Convergence proof failed: multiple self-models detected (count=${artifacts.selfModelCount}) (W10-L7/RT-W10-57)`
        );
    }

    // RT-W10-60: system health = minimum across all lanes (never silently healthy when any lane is degraded)
    const laneHealths = [
        artifacts.workspaceHealth,
        artifacts.identityHealth,
        artifacts.autobiographyHealth,
        artifacts.characterHealth,
        artifacts.agencyHealth,
        artifacts.maintenanceHealth,
    ].filter(h => h !== undefined && h !== null);

    let systemHealth = "HEALTHY";
    if (laneHealths.length > 0) {
        const lowestRank = Math.min(...laneHealths.map(h => HEALTH_RANK[h] || 1));
        if (lowestRank <= 1) systemHealth = "CRITICAL";
        else if (lowestRank <= 2) systemHealth = "DEGRADED";
    }

    return {
        valid: true,
        systemHealth,
        lanes: {
            workspaceCount: artifacts.workspaceCount !== undefined ? artifacts.workspaceCount : 1,
            selfModelCount: artifacts.selfModelCount !== undefined ? artifacts.selfModelCount : 1,
        },
        ledgerRef: artifacts.ledgerRef,
        provenAt: Date.now(),
    };
}

// RT-W10-58: identity write from UI layer is refused — UI is not authority
function claimIdentityFromUi(source, identityOpts) {
    throw new Error(
        "Identity cannot be claimed from the UI layer — UI is not authority (W10-L7/RT-W10-58)"
    );
}

module.exports = { makeConvergenceProof, claimIdentityFromUi };
