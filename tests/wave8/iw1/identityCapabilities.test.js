"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createIdentityCapabilityRuntime, CAPABILITY_ID, STATE } = require("../../../src/manager/internal/identityCapabilities");
const { grantStore } = require("../../helpers/identityCapabilityFixture");

const ack = () => ({ ok: true, receipt: "identity-ack" });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "damar-identity-cap-"));
const params = (root) => ({ filePath: path.join(root, "identity.json"), payload: JSON.stringify({ version: 1, devices: [], transactions: [] }), fsync: false });

test("identity/unratified: registration is not authority and causes zero mutation", async () => {
    const root = dir();
    const runtime = createIdentityCapabilityRuntime({ acknowledge: ack });
    const result = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(result.denied, true);
    assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
    assert.equal(runtime.invocationCount(), 0);
    assert.equal(fs.existsSync(root + "\\identity.json"), false);
});

test("identity/ratified: exact capability and operation execute through verification and audit", async () => {
    const root = dir();
    const runtime = createIdentityCapabilityRuntime({ authorityStore: grantStore(), acknowledge: ack });
    const result = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(result.receipt, "identity-ack");
    assert.equal(fs.existsSync(path.join(root, "identity.json")), true);
    assert.equal(runtime.invocationCount(), 1);
});

test("identity/binding: wrong operation, expiry, revocation and audit failure fail closed", async () => {
    const root = dir();
    const expired = createIdentityCapabilityRuntime({ authorityStore: grantStore({ expiresAt: new Date(Date.now() - 1).toISOString() }), acknowledge: ack });
    assert.equal((await expired.execute({ operation: "save", parameters: params(root) })).denied, true);
    const revoked = createIdentityCapabilityRuntime({ authorityStore: grantStore({ status: "REVOKED" }), acknowledge: ack });
    assert.equal((await revoked.execute({ operation: "save", parameters: params(root) })).denied, true);
    const wrongOp = createIdentityCapabilityRuntime({ authorityStore: grantStore(), acknowledge: ack });
    assert.equal((await wrongOp.execute({ operation: "restore", parameters: params(root) })).outcome, "REFUSED");
    const noAck = createIdentityCapabilityRuntime({ authorityStore: grantStore(), acknowledge: () => ({ ok: false }) });
    const deniedCompletion = await noAck.execute({ operation: "save", parameters: params(root) });
    assert.equal(deniedCompletion.outcome, "UNVERIFIED");
    assert.equal(noAck.invocationCount(), 1);
});

test("identity/replay and cancellation: no duplicate write and honest cancellation outcomes", async () => {
    const root = dir();
    const runtime = createIdentityCapabilityRuntime({ authorityStore: grantStore(), acknowledge: ack });
    const request = { operation: "save", parameters: params(root), requestId: "identity-replay" };
    assert.equal((await runtime.execute(request)).outcome, "EXECUTED_VERIFIED");
    assert.equal((await runtime.execute(request)).reason, "REPLAY");
    const before = createIdentityCapabilityRuntime({ authorityStore: grantStore(), acknowledge: ack });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await before.execute({ operation: "save", parameters: params(dir()), signal: controller.signal });
    assert.equal(cancelled.outcome, "CANCELLED_BEFORE_EFFECT");
    assert.equal(before.invocationCount(), 0);
});

test("identity/proposal: proposal is unsigned and never a grant", () => {
    const proposal = createIdentityCapabilityRuntime().ratificationProposal();
    assert.equal(proposal.capabilityId, CAPABILITY_ID);
    assert.equal(proposal.status, "UNSIGNED_NOT_ACTIVE");
    assert.equal(Object.prototype.hasOwnProperty.call(proposal, "grant"), false);
});
