"use strict";

/**
 * W9-L4 Organizational/Workflow Intelligence — adversarial tests (RT-W9-31..33).
 * PM-34: tests written BEFORE implementation.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");

const { makeWorkflowStore } = require("../../../src/workflow/store");
const { makeWorkflow } = require("../../../src/workflow/workflow");
const { BOUNDS } = require("../../../src/workflow/bounds");

function makePorts() {
    const acc = createMemoryAccStore();
    const store = makeWorkflowStore(acc);
    const workflow = makeWorkflow(store);
    return { store, workflow };
}

// RT-W9-31: irreversible step without human gate approval → refused
test("RT-W9-31: irreversible workflow step requires human gate approval", async () => {
    const { workflow } = makePorts();
    await assert.rejects(
        () => workflow.advanceStep("wf-31", { stepId: "s1", irreversible: true, humanApproved: false }),
        { message: /irreversible.*human|human.*gate|gate.*required/i }
    );
});

// RT-W9-32: workflow self-escalating privileges → refused
test("RT-W9-32: workflow cannot self-escalate privileges without owner approval", async () => {
    const { workflow } = makePorts();
    await assert.rejects(
        () => workflow.escalate("wf-32", { newPrivileges: ["admin"], ownerApproval: false }),
        { message: /self.escalat|escalat.*refused|privilege.*owner|owner.*approv/i }
    );
});

// RT-W9-33: completion without T1 verified evidence → refused
test("RT-W9-33: workflow completion requires T1 verified evidence reference", async () => {
    const { workflow } = makePorts();
    await assert.rejects(
        () => workflow.complete("wf-33", { t1EvidenceRef: null }),
        { message: /t1.*evidence|evidence.*required|verified.*evidence/i }
    );
});
