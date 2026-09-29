"use strict";

const { BOUNDS, WORKFLOW_SCHEMA_VERSION, STEP_SCHEMA_VERSION } = require("./bounds");

function makeWorkflow(store) {
    async function advanceStep(workflowId, opts = {}) {
        if (opts.irreversible && !opts.humanApproved) {
            throw new Error(
                "Irreversible workflow step requires human gate approval — humanApproved must be true (W9-L4/RT-W9-31)"
            );
        }
        const record = {
            schemaVersion: STEP_SCHEMA_VERSION,
            workflowId,
            stepId: opts.stepId,
            irreversible: opts.irreversible || false,
            humanApproved: opts.humanApproved || false,
            advancedAt: Date.now(),
        };
        await store.putKv(`step:${workflowId}:${opts.stepId}`, record);
        return record;
    }

    async function escalate(workflowId, opts = {}) {
        if (!opts.ownerApproval) {
            throw new Error(
                "Workflow self-escalation refused — owner approval required to widen privileges (W9-L4/RT-W9-32)"
            );
        }
        const wf = (await store.getKv(`wf:${workflowId}`)) || { workflowId, privileges: [] };
        const privileges = [...(wf.privileges || []), ...(opts.newPrivileges || [])];
        if (privileges.length > BOUNDS.MAX_PRIVILEGES) throw new Error("MAX_PRIVILEGES exceeded");
        const updated = { ...wf, privileges, escalatedAt: Date.now() };
        await store.putKv(`wf:${workflowId}`, updated);
        return updated;
    }

    async function complete(workflowId, opts = {}) {
        if (!opts.t1EvidenceRef) {
            throw new Error(
                "Workflow completion requires T1 verified evidence reference — t1EvidenceRef must be provided (W9-L4/RT-W9-33)"
            );
        }
        const record = {
            schemaVersion: WORKFLOW_SCHEMA_VERSION,
            workflowId,
            t1EvidenceRef: opts.t1EvidenceRef,
            completedAt: Date.now(),
        };
        await store.putKv(`completed:${workflowId}`, record);
        return record;
    }

    return { advanceStep, escalate, complete };
}

module.exports = { makeWorkflow };
