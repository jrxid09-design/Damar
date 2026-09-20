"use strict";

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");

/** W8-IW1: consequential execution requires a rollback-resistant replay substrate. */
function cliWithSubstrate(opts = {}) {
    return createCliCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

/**
 * W8-IW1 Phase 3B — CLI capability family.
 *
 * CLI is INGRESS, NEVER AUTHORITY. Consequential CLI operations are capabilities
 * and deny-until-ratified. The authorized side is exercised with a legitimate
 * owner-ratified authority fixture plus a composition-time recording driver (the
 * harness must not really spawn a daemon or an ssh tunnel); capability identity,
 * authority, verification and audit are untouched by that substitution.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    createCliCapabilityRuntime,
    CATALOGUE,
    STATE
} = require("../../../src/manager/internal/cliCapabilities.js");

const ack = (entries => (entry) => ({ ok: true, receipt: `ack-${entries.push(entry)}` }))([]);

function grantStore(grants) {
    const caps = new Map(grants.map((g) => [g.capabilityId, g]));
    return {
        async getCapability(id) {
            const g = caps.get(id);
            if (!g) return null;
            return {
                capabilityId: id,
                status: g.status ?? "ACTIVE",
                generation: 0,
                payload: {
                    subject: "owner",
                    capabilityId: id,
                    kind: "root",
                    actions: ["execute"],
                    scope: g.scope ?? [],
                    allowedPurposes: [],
                    restrictions: { kind: "unrestricted" },
                    maxExecutions: null,
                    identityBinding: g.identityBinding ?? null,
                    notBefore: null,
                    expiresAt: g.expiresAt ?? null,
                    issuedAt: new Date().toISOString()
                }
            };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

/** Recording driver double: counts calls, starts nothing. */
function recordingDriver(result) {
    const calls = [];
    return {
        calls,
        driver: async ({ parameters }) => { calls.push(parameters); return result; }
    };
}

// ---------------------------------------------------------------- A. INGRESS HAS NO SPAWN

test("cli/structural: src/cli/index.js holds no process-spawning sink", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../../src/cli/index.js"), "utf8");
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/require\(\s*["']node:child_process["']\s*\)/.test(code), false, "no child_process require in the CLI");
    assert.equal(/\bspawn\s*\(/.test(code), false, "no spawn call in the CLI");
    assert.equal(/\bexecFile\s*\(/.test(code), false, "no execFile call in the CLI");
});

// ---------------------------------------------------------------- B. UNRATIFIED

test("cli/unratified: no authority store denies every CLI capability with zero effect", async () => {
    const runtime = cliWithSubstrate({ acknowledge: ack });
    for (const [rawId, spec] of Object.entries(CATALOGUE)) {
        for (const operation of spec.operations) {
            const result = await runtime.execute({ capabilityId: rawId, operation, parameters: { target: "user@host" } });
            assert.equal(result.denied, true, `${rawId}|${operation}`);
            assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
            assert.equal(result.ownerRatificationRequired, true);
            assert.equal(result.reason, "AUTHORITY_UNAVAILABLE");
            assert.equal(runtime.invocationCount(rawId), 0, "no driver may run without authority");
        }
    }
    const availability = await runtime.availability();
    for (const state of Object.values(availability)) {
        assert.equal(state.state, STATE.OWNER_RATIFICATION_REQUIRED);
    }
});

test("cli/unratified: a store without a grant denies and starts no process", async () => {
    const runtime = cliWithSubstrate({ authorityStore: grantStore([]), acknowledge: ack });
    const result = await runtime.execute({ capabilityId: "cli.daemon.start", operation: "serve", parameters: {} });
    assert.equal(result.denied, true);
    assert.equal(result.state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);
    assert.equal(result.reason, "CAP_NOT_FOUND");
    assert.equal(runtime.invocationCount("cli.daemon.start"), 0);
});

test("cli/unratified: a denied ssh request never reaches the driver", async () => {
    const spy = recordingDriver({ ok: true, localPort: 1 });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const result = await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(result.denied, true);
    assert.equal(spy.calls.length, 0, "zero process, zero network");
});

// ---------------------------------------------------------------- C. RATIFIED FIXTURE

test("cli/ratified: an ACTIVE grant executes through authority, verification and audit", async () => {
    const spy = recordingDriver({ ok: true, localPort: 43210, sshTarget: "user@host" });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: (entry) => { ack(entry); return { ok: true, receipt: "cli-ack" }; },
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });

    const availability = await runtime.availability();
    assert.equal(availability["cli.ssh.tunnel"].state, STATE.AUTHORIZED);
    assert.equal(availability["cli.daemon.start"].state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);

    const result = await runtime.execute({
        capabilityId: "cli.ssh.tunnel",
        operation: "open",
        parameters: { target: "user@host" }
    });

    assert.equal(result.outcome, "EXECUTED_VERIFIED", JSON.stringify(result));
    assert.equal(result.verification.state, "verified", "verification ran before completion");
    assert.equal(result.receipt, "cli-ack", "durable acknowledgement bound the completion");
    assert.equal(result.result.localPort, 43210);
    assert.equal(spy.calls.length, 1, "exactly one driver invocation");
    assert.deepEqual(spy.calls[0], { target: "user@host" });
    assert.equal(runtime.invocationCount("cli.ssh.tunnel"), 1);
});

test("cli/ratified: driver substitution cannot widen authority (identity is capability-bound)", async () => {
    const spy = recordingDriver({ ok: true, pid: 1234 });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: ack,
        driverOverrides: { "cli.daemon.start": { serve: spy.driver } }
    });
    const result = await runtime.execute({ capabilityId: "cli.daemon.start", operation: "serve", parameters: {} });
    assert.equal(result.denied, true, "override does not authorize the capability");
    assert.equal(result.reason, "CAP_NOT_FOUND");
    assert.equal(spy.calls.length, 0);
});

test("cli/ratified: verification failure withholds canonical completion", async () => {
    const spy = recordingDriver({ ok: false, error: "TUNNEL_NOT_READY" });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const result = await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(result.outcome, "UNVERIFIED");
    assert.notEqual(result.denied, true, "the effect WAS invoked, so this is not a denial");
    assert.ok(result.verification.state !== "verified");
});

test("cli/ratified: audit acknowledgement failure withholds canonical completion", async () => {
    const spy = recordingDriver({ ok: true, localPort: 4242 });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: () => ({ ok: false }),
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const result = await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(result.outcome, "UNVERIFIED");
    assert.equal(result.reason, "AUDIT_NOT_ACKNOWLEDGED");
});

// ---------------------------------------------------------------- D. BINDING NEGATIVES

test("cli/binding: malformed target is refused before authority (zero effect)", async () => {
    const spy = recordingDriver({ ok: true, localPort: 1 });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    for (const target of ["", "not a host!!", "host with space", "a@b@c"]) {
        const result = await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target } });
        assert.equal(result.outcome, "REFUSED", `target="${target}"`);
        assert.equal(result.reason, "TARGET_MALFORMED");
    }
    assert.equal(spy.calls.length, 0);
});

test("cli/binding: wrong capability and wrong operation fail closed", async () => {
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: ack
    });
    const wrongCapability = await runtime.execute({ capabilityId: "cli.daemon.start", operation: "serve", parameters: {} });
    assert.equal(wrongCapability.denied, true);
    assert.equal(wrongCapability.reason, "CAP_NOT_FOUND");

    const wrongOperation = await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "serve", parameters: {} });
    assert.equal(wrongOperation.outcome, "REFUSED");
    assert.equal(wrongOperation.reason, "CAPABILITY_UNBOUND");
    assert.equal(runtime.invocationCount("cli.ssh.tunnel"), 0);
});

test("cli/binding: wrong principal and scope mismatch fail closed", async () => {
    const spy = recordingDriver({ ok: true, localPort: 4141 });
    const bound = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel", identityBinding: { principals: ["owner"] } }]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const ok = await bound.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" }, identity: { principal: "owner" } });
    assert.equal(ok.outcome, "EXECUTED_VERIFIED");

    const intruder = await bound.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" }, identity: { principal: "intruder" } });
    assert.equal(intruder.denied, true);
    assert.equal(intruder.reason, "CAP_IDENTITY_MISMATCH");

    const scoped = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel", scope: ["host:example.com"] }]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const unscoped = await scoped.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(unscoped.denied, true);
    assert.equal(unscoped.reason, "CAP_SCOPE_MISMATCH");
    assert.equal(spy.calls.length, 1, "only the authorized owner call reached the driver");
});

test("cli/binding: expired and revoked grants fail closed", async () => {
    const expired = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel", expiresAt: new Date(Date.now() - 1000).toISOString() }]),
        acknowledge: ack
    });
    const expiredResult = await expired.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(expiredResult.denied, true);
    assert.equal(expiredResult.reason, "CAP_EXPIRED");

    const revoked = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel", status: "REVOKED" }]),
        acknowledge: ack
    });
    const revokedResult = await revoked.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } });
    assert.equal(revokedResult.denied, true);
    assert.equal(revokedResult.reason, "CAP_REVOKED");
    assert.equal(revoked.invocationCount("cli.ssh.tunnel"), 0);
});

test("cli/binding: identical request cannot run twice; changed parameters are a new request", async () => {
    const spy = recordingDriver({ ok: true, localPort: 4242 });
    const runtime = cliWithSubstrate({
        authorityStore: grantStore([{ capabilityId: "cli.ssh.tunnel" }]),
        acknowledge: ack,
        driverOverrides: { "cli.ssh.tunnel": { open: spy.driver } }
    });
    const request = { capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "user@host" } };
    const first = await runtime.execute(request);
    const second = await runtime.execute(request);
    assert.equal(first.outcome, "EXECUTED_VERIFIED");
    assert.equal(second.outcome, "REFUSED");
    assert.equal(second.reason, "REPLAY");
    assert.equal(spy.calls.length, 1, "exactly-once");

    await runtime.execute({ capabilityId: "cli.ssh.tunnel", operation: "open", parameters: { target: "other@host" } });
    assert.equal(spy.calls.length, 2);
});

test("cli/binding: the runtime exposes no seam accepting a caller-supplied evaluation", () => {
    const runtime = cliWithSubstrate({ acknowledge: ack });
    for (const key of Object.keys(runtime)) {
        assert.ok(!/evaluation|grant|authorize/i.test(key), `runtime must not expose authority input: ${key}`);
    }
});

test("cli/proposal: the ratification bundle is unsigned and grants nothing", async () => {
    const runtime = cliWithSubstrate({ authorityStore: grantStore([]), acknowledge: ack });
    const bundle = runtime.ratificationProposal();
    assert.equal(bundle.kind, "OWNER_RATIFICATION_PROPOSAL");
    assert.equal(bundle.status, "UNSIGNED_NOT_ACTIVE");
    assert.equal(bundle.proposals.length, Object.keys(CATALOGUE).length);
    for (const p of bundle.proposals) {
        assert.equal(p.proposalDigest.length, 64);
        assert.equal(p.principal, "owner");
    }
    const availability = await runtime.availability();
    for (const state of Object.values(availability)) {
        assert.equal(state.state, STATE.AVAILABLE_BUT_NOT_AUTHORIZED);
    }
});
