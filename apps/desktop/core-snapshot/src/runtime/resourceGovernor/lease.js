"use strict";

const BRAND = Symbol("damar.resourceGovernor.leaseBrand");

let leaseCounter = 0;

function createResourceLease({ leaseId, workloadId, workloadClass, group, admittedAt, expiresAt, reservedDemand, generation }) {
    const lease = Object.freeze({
        [BRAND]: true,
        kind: "ResourceLease",
        leaseId,
        workloadId,
        workloadClass,
        group,
        admittedAt,
        expiresAt,
        reservedDemand,
        generation
    });
    return lease;
}

function nextLeaseId(clock) {
    const t = clock.nowMs().toString(36);
    const n = (++leaseCounter).toString(36).padStart(6, "0");
    return `lease-${t}-${n}`;
}

module.exports = { createResourceLease, nextLeaseId };
