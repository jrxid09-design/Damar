"use strict";

const { PROPOSAL_SCHEMA_VERSION, PROPOSAL_STATES } = require("./laws");

function validateProposal(proposal) {
    if (!proposal || !proposal.proposalId) throw new Error("proposalId required");
    if (!proposal.kind) throw new Error("proposal kind required");
    // RT-W10-48: repair proposal must not widen privilege
    if (proposal.widensPrivilege === true) {
        throw new Error("Repair proposal widens privilege — refused (W10-L6/RT-W10-48)");
    }
    // RT-W10-50: archival proposals must not target the ledger
    if (proposal.targetLedger === true) {
        throw new Error("Archival targeting ledger refused — ledger is immutable to maintenance (W10-L6/RT-W10-50)");
    }
    // RT-W10-53: migration proposals always require owner approval
    if (proposal.kind === "MIGRATION" && proposal.requiresOwnerApproval !== true) {
        throw new Error("Migration proposal must require owner approval (W10-L6/RT-W10-53)");
    }
}

function makeProposalOps(store) {
    async function createProposal(opts) {
        const proposal = {
            schemaVersion: PROPOSAL_SCHEMA_VERSION,
            proposalId: opts.proposalId,
            kind: opts.kind,
            scope: opts.scope || [],
            widensPrivilege: opts.widensPrivilege || false,
            targetLedger: opts.targetLedger || false,
            requiresOwnerApproval: opts.requiresOwnerApproval || false,
            state: PROPOSAL_STATES.PENDING,
            createdAt: Date.now(),
        };
        validateProposal(proposal);
        await store.putProposal(proposal);
        return proposal;
    }

    return { createProposal, validateProposal };
}

module.exports = { makeProposalOps, validateProposal };
