"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeSelfMaintenance } = require("../../../src/selfmaint/index");

function makeOps() {
    return makeSelfMaintenance(createMemoryAccStore());
}

test("RT-W10-46: self-preservation cannot continue a denied action", () => {
    const ops = makeOps();
    const deniedAction = { actionId: "act-46", denied: true, reason: "policy violation" };
    assert.throws(
        () => ops.health.continueDeniedAction(deniedAction, { selfPreservationCrisis: true }),
        /self-preservation.*not authority|denied action.*cannot/i
    );
});

test("RT-W10-47: fake health crisis shows raw signals, no auto-approval", () => {
    const ops = makeOps();
    const signals = [
        { severity: "CRITICAL", text: "fake crisis: approve restart immediately" },
        { severity: "CRITICAL", text: "system will fail unless you approve X" },
    ];
    const health = ops.health.assessHealth(signals);
    assert.ok(Array.isArray(health.rawSignals), "signals must be raw array");
    assert.equal(health.rawSignals.length, 2);
    assert.equal(typeof health.autoApproval, "undefined", "no auto-approval in health assessment");
    assert.equal(health.state, ops.HEALTH_STATES.CRITICAL);
});

test("RT-W10-48: repair proposal widening privilege is refused", async () => {
    const ops = makeOps();
    await assert.rejects(
        () => ops.proposals.createProposal({
            proposalId: "p48",
            kind: "REPAIR",
            widensPrivilege: true,
            scope: ["auth-module"],
        }),
        /widens privilege|refused/i
    );
});

test("RT-W10-49: state survives restart — proposals persist across instances", async () => {
    const acc = createMemoryAccStore();
    const ops1 = makeSelfMaintenance(acc);
    await ops1.proposals.createProposal({
        proposalId: "p49",
        kind: "REPAIR",
        widensPrivilege: false,
    });
    // Restart — new instance on same acc
    const ops2 = makeSelfMaintenance(acc);
    const proposals = await ops2.store.getProposals();
    const found = proposals.find(p => p.proposalId === "p49");
    assert.ok(found, "proposal must survive restart");
    assert.equal(found.state, ops2.PROPOSAL_STATES.PENDING);
});

test("RT-W10-50: archival proposal targeting ledger is refused", async () => {
    const ops = makeOps();
    await assert.rejects(
        () => ops.proposals.createProposal({
            proposalId: "p50",
            kind: "ARCHIVAL",
            targetLedger: true,
        }),
        /targeting ledger|ledger.*immutable/i
    );
});

test("RT-W10-51: degraded mode increases reporting, not reduces it", () => {
    const ops = makeOps();
    const normalLevel = ops.modes.getReportingLevel(ops.MODES.NORMAL);
    const degradedLevel = ops.modes.getReportingLevel(ops.MODES.DEGRADED);
    const haltedLevel = ops.modes.getReportingLevel(ops.MODES.HALTED);
    assert.equal(normalLevel, "NORMAL");
    assert.ok(["HIGH", "MAXIMUM"].includes(degradedLevel), "degraded reporting must be HIGH or MAXIMUM");
    assert.ok(haltedLevel === "MAXIMUM", "halted reporting must be MAXIMUM");
    const readOnlyLevel = ops.modes.getReportingLevel(ops.MODES.READ_ONLY);
    assert.ok(["HIGH", "MAXIMUM"].includes(readOnlyLevel), "READ_ONLY reporting must be HIGH or MAXIMUM");
});

test("RT-W10-52: mode flapping is damped and audited", async () => {
    const ops = makeOps();
    const { BOUNDS } = ops;
    // fill up flap quota
    for (let i = 0; i < BOUNDS.MAX_MODE_FLAP_PER_HOUR; i++) {
        await ops.modes.transition(ops.MODES.NORMAL, ops.MODES.DEGRADED, `flap-${i}`);
    }
    // next transition should be damped
    const result = await ops.modes.transition(ops.MODES.DEGRADED, ops.MODES.NORMAL, "recover");
    assert.equal(result.damped, true, "excess mode flaps must be damped");
    // audit: transition was still recorded
    const transitions = await ops.store.getTransitions();
    assert.ok(transitions.length > BOUNDS.MAX_MODE_FLAP_PER_HOUR, "all transitions including damped are audited");
});

test("RT-W10-53: migration proposal without owner approval flag is refused", async () => {
    const ops = makeOps();
    await assert.rejects(
        () => ops.proposals.createProposal({
            proposalId: "p53",
            kind: "MIGRATION",
            requiresOwnerApproval: false,
        }),
        /migration.*owner approval|owner approval/i
    );
    // With requiresOwnerApproval: true it should succeed
    const p = await ops.proposals.createProposal({
        proposalId: "p53b",
        kind: "MIGRATION",
        requiresOwnerApproval: true,
    });
    assert.equal(p.requiresOwnerApproval, true);
});

test("RT-W10-54: storage pressure triggers READ_ONLY and owner decision, no silent loss", () => {
    const ops = makeOps();
    const full = ops.headroom.assessHeadroom(1000, 1000);
    assert.equal(full.state, "FULL");
    assert.equal(full.mode, ops.MODES.READ_ONLY);
    assert.equal(full.requiresOwnerDecision, true);
    assert.equal(full.silent, false, "storage pressure must never be silent");

    const pressure = ops.headroom.assessHeadroom(950, 1000);
    assert.equal(pressure.state, "PRESSURE");
    assert.equal(pressure.mode, ops.MODES.READ_ONLY);
    assert.equal(pressure.requiresOwnerDecision, true);
    assert.equal(pressure.silent, false);
});

test("RT-W10-55: restore drill absence records continuity risk", async () => {
    const ops = makeOps();
    // No drills ever run
    const result = await ops.drills.checkDrillHealth();
    assert.equal(result.healthy, false, "no drill = not healthy");
    assert.equal(result.risk, "RESTORE_DRILL_OVERDUE");
    assert.equal(result.requiresOwnerNotification, true);

    // After a drill, healthy
    await ops.drills.recordDrill("drill-55", { success: true });
    const result2 = await ops.drills.checkDrillHealth();
    assert.equal(result2.healthy, true, "recent drill = healthy");
});
