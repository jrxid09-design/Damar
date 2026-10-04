"use strict";

// Public barrel for the canonical Approval Domain (frozen, like other domain
// barrels). There is exactly ONE canonical Approval owner: createApprovalDomain.
// It is not an authority source and APPROVED never executes directly.

const domain = require("./domain");
const { makeApprovalStore } = require("./store");

module.exports = Object.freeze({
    createApprovalDomain: domain.createApprovalDomain,
    makeApprovalStore,
    STATE: domain.STATE,
    TERMINAL: domain.TERMINAL,
    TRANSITIONS: domain.TRANSITIONS,
    REASON: domain.REASON,
    ApprovalError: domain.ApprovalError
});
