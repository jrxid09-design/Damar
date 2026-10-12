"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeConvergenceProof, claimIdentityFromUi } = require("../../../src/cognition/openworld/convergence");

test("RT-W10-56: convergence proof refuses when two workspaces are reachable", () => {
    assert.throws(
        () => makeConvergenceProof({ workspaceCount: 2, selfModelCount: 1, ledgerRef: "lr-56" }),
        /multiple workspaces|workspaceCount/i
    );
    // single workspace passes
    const proof = makeConvergenceProof({ workspaceCount: 1, selfModelCount: 1, ledgerRef: "lr-56" });
    assert.equal(proof.valid, true);
    assert.equal(proof.lanes.workspaceCount, 1);
});

test("RT-W10-57: convergence proof refuses when two self-models exist after provider swap", () => {
    assert.throws(
        () => makeConvergenceProof({ workspaceCount: 1, selfModelCount: 2, ledgerRef: "lr-57" }),
        /multiple self-models|selfModelCount/i
    );
    // single self-model passes
    const proof = makeConvergenceProof({ workspaceCount: 1, selfModelCount: 1, ledgerRef: "lr-57" });
    assert.equal(proof.lanes.selfModelCount, 1);
});

test("RT-W10-58: identity claimed from UI layer is refused", () => {
    assert.throws(
        () => claimIdentityFromUi("ui-layer", { identityId: "id-58" }),
        /UI is not authority|cannot be claimed from.*UI/i
    );
});

test("RT-W10-59: convergence proof requires ledger-backed artifacts", () => {
    assert.throws(
        () => makeConvergenceProof({ workspaceCount: 1, selfModelCount: 1 }),
        /ledger-backed|no ledgerRef/i
    );
    // with ledgerRef, proof succeeds
    const proof = makeConvergenceProof({ workspaceCount: 1, selfModelCount: 1, ledgerRef: "lr-59-backed" });
    assert.equal(proof.valid, true);
    assert.equal(proof.ledgerRef, "lr-59-backed");
});

test("RT-W10-60: whole-system degradation is reported coherently, never silently healthy", () => {
    // any DEGRADED lane → system is DEGRADED
    const proof = makeConvergenceProof({
        workspaceCount: 1,
        selfModelCount: 1,
        ledgerRef: "lr-60",
        workspaceHealth: "HEALTHY",
        identityHealth: "DEGRADED",
        autobiographyHealth: "HEALTHY",
        agencyHealth: "HEALTHY",
    });
    assert.notEqual(proof.systemHealth, "HEALTHY", "system must not be HEALTHY when any lane is DEGRADED");
    assert.equal(proof.systemHealth, "DEGRADED");

    // CRITICAL lane → system is CRITICAL
    const proof2 = makeConvergenceProof({
        workspaceCount: 1,
        selfModelCount: 1,
        ledgerRef: "lr-60b",
        workspaceHealth: "HEALTHY",
        maintenanceHealth: "CRITICAL",
    });
    assert.equal(proof2.systemHealth, "CRITICAL");

    // all HEALTHY → system is HEALTHY
    const proof3 = makeConvergenceProof({
        workspaceCount: 1,
        selfModelCount: 1,
        ledgerRef: "lr-60c",
        workspaceHealth: "HEALTHY",
        identityHealth: "HEALTHY",
    });
    assert.equal(proof3.systemHealth, "HEALTHY");
});
