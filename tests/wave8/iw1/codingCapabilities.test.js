"use strict";

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");

/** W8-IW1: consequential execution requires a rollback-resistant replay substrate. */
function codingWithSubstrate(opts = {}) {
    return createCodingCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

/**
 * W8-IW1 Phase 3B — CodingBrain family migration.
 *
 * The family is migrated and left DENY-UNTIL-RATIFIED: without a valid,
 * owner-ratified grant every capability denies with zero driver invocation. The
 * authorized side is exercised only through legitimate authority fixtures built
 * on the real ratification contract (a rehydratable ACTIVE grant in a canonical
 * authority store) — never by manually branding an evaluation object.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const {
    createCodingCapabilityRuntime,
    CATALOGUE,
    STATE
} = require("../../../src/manager/internal/codingCapabilities.js");

/**
 * Canonical authority store fixture: an ACTIVE root grant, rehydratable by
 * loadAndEvaluateAuthority (the exact shape the production store persists).
 */
function grantStore(entries) {
    const caps = new Map(entries.map((e) => [e.capabilityId, e]));
    return {
        async getCapability(id) {
            const e = caps.get(id);
            if (!e) return null;
            return {
                capabilityId: id,
                status: e.status ?? "ACTIVE",
                generation: e.generation ?? 0,
                payload: {
                    subject: e.subject ?? "owner",
                    capabilityId: id,
                    kind: "root",
                    actions: e.actions ?? ["execute"],
                    scope: e.scope ?? [],
                    allowedPurposes: [],
                    restrictions: { kind: "unrestricted" },
                    maxExecutions: null,
                    identityBinding: e.identityBinding ?? null,
                    notBefore: null,
                    expiresAt: e.expiresAt ?? null,
                    issuedAt: new Date().toISOString()
                }
            };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

const ack = () => ({ ok: true, receipt: "test-ack" });
const tempDir = () => require("node:fs").mkdtempSync(path.join(os.tmpdir(), "damar-coding-"));

// ---------------------------------------------------------------- A. UNRATIFIED

test("coding/unratified: no authority store at all denies every capability with zero driver invocation", async () => {
    const runtime = codingWithSubstrate({ acknowledge: ack });
    const before = Object.keys(CATALOGUE).map((id) => runtime.invocationCount(id));

    const result = await runtime.execute({ capabilityId: "coding.git.write", operation: "commit", parameters: { args: ["msg", process.cwd()] } });
    assert.equal(result.denied, true);
    assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
    assert.equal(result.ownerRatificationRequired, true);
    assert.equal(result.reason, "AUTHORITY_UNAVAILABLE");

    const after = Object.keys(CATALOGUE).map((id) => runtime.invocationCount(id));
    assert.deepEqual(after, before, "no driver may be invoked without authority");

    const availability = await runtime.availability();
    for (const state of Object.values(availability)) {
        assert.equal(state.state, STATE.OWNER_RATIFICATION_REQUIRED);
    }
});

test("coding/unratified: a store without a grant denies and never reaches the driver", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([]),          // no grants at all
        acknowledge: ack
    });

    const adapter = runtime.adapter("patcher");
    const isRepo = await adapter.isRepo(process.cwd());
    assert.equal(isRepo.denied, true);
    assert.equal(isRepo.state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);
    assert.equal(isRepo.capabilityId, "coding.git.read");
    assert.equal(isRepo.reason, "CAP_NOT_FOUND");

    const result = await runtime.execute({ capabilityId: "coding.git.read", operation: "status", parameters: { args: [process.cwd()] } });
    assert.equal(result.denied, true);
    assert.equal(result.state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);
    assert.equal(result.reason, "CAP_NOT_FOUND");

    assert.equal(runtime.invocationCount("coding.git.read"), 0, "zero process spawn");
    assert.equal(runtime.invocationCount("coding.git.write"), 0, "zero repository mutation");
});

test("coding/unratified: model-supplied parameters cannot select a handler or smuggle code", async () => {
    const runtime = codingWithSubstrate({ authorityStore: grantStore([]), acknowledge: ack });
    const result = await runtime.execute({
        capabilityId: "coding.git.write",
        operation: "commit",
        parameters: { args: ["msg", process.cwd()], handler: () => ({ ok: true }) }
    });
    // Authorization is evaluated first, so the refusal is the authority denial;
    // either way the driver is never reached and nothing executes.
    assert.notEqual(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(runtime.invocationCount("coding.git.write"), 0);
});

// ------------------------------------------------- B. VALID OWNER-RATIFIED FIXTURE

test("coding/ratified: an ACTIVE owner grant executes through authority, verification and audit", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });

    const availability = await runtime.availability();
    assert.equal(availability["coding.git.read"].state, STATE.AUTHORIZED);
    assert.equal(availability["coding.git.write"].state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);

    const result = await runtime.execute({
        capabilityId: "coding.git.read",
        operation: "isRepo",
        parameters: { args: [process.cwd()] }
    });

    assert.equal(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(result.effectInvoked, true);
    assert.equal(result.verification.state, "verified", "verification ran before completion");
    assert.equal(result.receipt, "test-ack", "durable acknowledgement bound the completion");
    assert.equal(result.result, true, "the real git driver ran and reported the repository");
    assert.equal(runtime.invocationCount("coding.git.read"), 1);
});

test("coding/ratified: adapter surface executes for an authorized capability only", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });

    const readAdapter = runtime.adapter("patcher");
    const authorized = await readAdapter.isRepo(process.cwd());
    assert.equal(authorized, true, "authorized read returns the driver result, not a denial");

    // Same adapter, write method: its capability is not granted.
    const denied = await readAdapter.commit("nope", process.cwd());
    assert.equal(denied.denied, true);
    assert.equal(denied.capabilityId, "coding.git.write");
    assert.equal(runtime.invocationCount("coding.git.write"), 0);
});

test("coding/ratified: audit acknowledgement failure withholds canonical completion", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: () => ({ ok: false })
    });
    const result = await runtime.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } });
    assert.equal(result.outcome, "UNVERIFIED");
    assert.equal(result.reason, "AUDIT_NOT_ACKNOWLEDGED");
});

// ------------------------------------------------------- C. BINDING NEGATIVES

test("coding/binding: wrong capability has no grant and fails closed", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });
    const result = await runtime.execute({ capabilityId: "coding.git.write", operation: "commit", parameters: { args: ["m", process.cwd()] } });
    assert.equal(result.denied, true);
    assert.equal(result.reason, "CAP_NOT_FOUND");
    assert.equal(runtime.invocationCount("coding.git.write"), 0);
});

test("coding/binding: wrong operation on a granted capability is refused", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });
    const result = await runtime.execute({ capabilityId: "coding.git.read", operation: "push", parameters: { args: [] } });
    assert.equal(result.outcome, "REFUSED");
    assert.equal(result.reason, "CAPABILITY_UNBOUND");
    assert.equal(runtime.invocationCount("coding.git.read"), 0);
});

test("coding/binding: wrong principal fails closed", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{
            capabilityId: "coding.git.read",
            identityBinding: { principals: ["owner"] }
        }]),
        acknowledge: ack
    });
    const ok = await runtime.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] }, identity: { principal: "owner" } });
    assert.equal(ok.outcome, "EXECUTED_VERIFIED");

    const bad = await runtime.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] }, identity: { principal: "intruder" } });
    assert.equal(bad.denied, true);
    assert.equal(bad.reason, "CAP_IDENTITY_MISMATCH");
});

test("coding/binding: a scoped grant is not satisfied by an unscoped request", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read", scope: ["project:alpha"] }]),
        acknowledge: ack
    });
    const result = await runtime.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } });
    assert.equal(result.denied, true);
    assert.equal(result.reason, "CAP_SCOPE_MISMATCH");
    assert.equal(runtime.invocationCount("coding.git.read"), 0, "zero effect on a scope mismatch");
});

test("coding/binding: expired and revoked grants fail closed", async () => {
    const expired = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read", expiresAt: new Date(Date.now() - 60_000).toISOString() }]),
        acknowledge: ack
    });
    const expiredResult = await expired.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } });
    assert.equal(expiredResult.denied, true);
    assert.equal(expiredResult.reason, "CAP_EXPIRED");

    const revoked = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read", status: "REVOKED" }]),
        acknowledge: ack
    });
    const revokedResult = await revoked.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } });
    assert.equal(revokedResult.denied, true);
    assert.equal(revokedResult.reason, "CAP_REVOKED");
    assert.equal(revoked.invocationCount("coding.git.read"), 0);
});

test("coding/binding: an identical request cannot invoke the driver twice (replay)", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });
    const request = { capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } };
    const first = await runtime.execute(request);
    const second = await runtime.execute(request);
    assert.equal(first.outcome, "EXECUTED_VERIFIED");
    assert.equal(second.outcome, "REFUSED");
    assert.equal(second.reason, "REPLAY");
    assert.equal(runtime.invocationCount("coding.git.read"), 1, "exact-once: one driver invocation");
});

test("coding/binding: changed parameters are a different request, not a replayed one", async () => {
    const runtime = codingWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "coding.git.read" }]),
        acknowledge: ack
    });
    await runtime.execute({ capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [process.cwd()] } });
    await runtime.execute({ capacityNote: "different args", capabilityId: "coding.git.read", operation: "isRepo", parameters: { args: [tempDir()] } });
    assert.equal(runtime.invocationCount("coding.git.read"), 2);
});

test("coding/binding: the runtime exposes no seam that accepts a caller-supplied evaluation", () => {
    const runtime = codingWithSubstrate({ authorityStore: grantStore([]), acknowledge: ack });
    for (const key of Object.keys(runtime)) {
        assert.ok(!/evaluation|grant|authorize/i.test(key), `runtime must not expose authority input: ${key}`);
    }
});

test("coding/proposal: the ratification bundle is a proposal, never authority", async () => {
    const runtime = codingWithSubstrate({ authorityStore: grantStore([]), acknowledge: ack });
    const bundle = runtime.ratificationProposal();
    assert.equal(bundle.kind, "OWNER_RATIFICATION_PROPOSAL");
    assert.equal(bundle.status, "UNSIGNED_NOT_ACTIVE");
    assert.equal(bundle.proposals.length, Object.keys(CATALOGUE).length);
    for (const p of bundle.proposals) {
        assert.equal(typeof p.proposalDigest, "string");
        assert.equal(p.proposalDigest.length, 64);
        assert.equal(p.principal, "owner");
    }
    // Producing a proposal must not change what is authorized.
    const availability = await runtime.availability();
    for (const state of Object.values(availability)) {
        assert.equal(state.state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);
    }
});
