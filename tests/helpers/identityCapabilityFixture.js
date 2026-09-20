"use strict";

const { createIdentityCapabilityRuntime, CAPABILITY_ID } = require("../../src/manager/internal/identityCapabilities");

function grantStore({ status = "ACTIVE", expiresAt = null, scope = [], capabilityId = CAPABILITY_ID } = {}) {
    return {
        async getCapability(id) {
            if (id !== capabilityId) return null;
            return { capabilityId: id, status, generation: 0, payload: {
                subject: "owner", capabilityId: id, kind: "root", actions: ["execute"], scope,
                allowedPurposes: [], restrictions: { kind: "unrestricted" }, maxExecutions: null,
                identityBinding: null, notBefore: null, expiresAt, issuedAt: new Date().toISOString()
            } };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

function identityCapabilityRuntime(options = {}) {
    return createIdentityCapabilityRuntime({
        authorityStore: grantStore(options),
        acknowledge: options.acknowledge ?? (() => ({ ok: true, receipt: "identity-test-ack" }))
    });
}

module.exports = { CAPABILITY_ID, grantStore, identityCapabilityRuntime };
