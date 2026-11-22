"use strict";

function validProbeIdentity(probeId, capabilityId) {
    return [probeId, capabilityId].every(value => typeof value === "string" && value.length > 0 && value.length <= 200);
}

module.exports = { validProbeIdentity };
