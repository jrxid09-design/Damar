"use strict";

const { createRollbackResistantLedger } = require("../../helpers/rollbackSubstrate");

/** W8-IW1: consequential execution requires a rollback-resistant replay substrate. */
function identityWithSubstrate(opts = {}) {
    return createIdentityCapabilityRuntime({ ...opts, replayStore: opts.replayStore ?? createRollbackResistantLedger() });
}

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { createIdentityCapabilityRuntime, CAPABILITY_ID, STATE } = require("../../../src/manager/internal/identityCapabilities");
const { createFileIdentityStore } = require("../../../src/embodiment/identity/store");
const { createCanonicalReplayLedger } = require("../../../src/manager/internal/canonicalReplayLedger");
const { grantStore } = require("../../helpers/identityCapabilityFixture");

const ack = () => ({ ok: true, receipt: "identity-ack" });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "damar-identity-cap-"));
const params = (root) => ({ filePath: path.join(root, "identity.json"), payload: JSON.stringify({ version: 1, devices: [], transactions: [] }), fsync: false });

test("identity/unratified: registration is not authority and causes zero mutation", async () => {
    const root = dir();
    const runtime = identityWithSubstrate({ acknowledge: ack });
    const result = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(result.denied, true);
    assert.equal(result.state, STATE.OWNER_RATIFICATION_REQUIRED);
    assert.equal(runtime.invocationCount(), 0);
    assert.equal(fs.existsSync(root + "\\identity.json"), false);
});

test("identity/ratified: exact capability and operation execute through verification and audit", async () => {
    const root = dir();
    const runtime = identityWithSubstrate({ authorityStore: grantStore(), acknowledge: ack });
    const result = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(result.receipt, "identity-ack");
    assert.equal(fs.existsSync(path.join(root, "identity.json")), true);
    assert.equal(runtime.invocationCount(), 1);
});

test("identity/binding: wrong operation, expiry, revocation and audit failure fail closed", async () => {
    const root = dir();
    const expired = identityWithSubstrate({ authorityStore: grantStore({ expiresAt: new Date(Date.now() - 1).toISOString() }), acknowledge: ack });
    assert.equal((await expired.execute({ operation: "save", parameters: params(root) })).denied, true);
    const revoked = identityWithSubstrate({ authorityStore: grantStore({ status: "REVOKED" }), acknowledge: ack });
    assert.equal((await revoked.execute({ operation: "save", parameters: params(root) })).denied, true);
    const wrongOp = identityWithSubstrate({ authorityStore: grantStore(), acknowledge: ack });
    assert.equal((await wrongOp.execute({ operation: "restore", parameters: params(root) })).outcome, "REFUSED");
    const noAck = identityWithSubstrate({ authorityStore: grantStore(), acknowledge: () => ({ ok: false }) });
    const deniedCompletion = await noAck.execute({ operation: "save", parameters: params(root) });
    assert.equal(deniedCompletion.outcome, "UNVERIFIED");
    assert.equal(noAck.invocationCount(), 1);
});

test("identity/replay and cancellation: no duplicate write and honest cancellation outcomes", async () => {
    const root = dir();
    const runtime = identityWithSubstrate({ authorityStore: grantStore(), acknowledge: ack });
    const request = { operation: "save", parameters: params(root), requestId: "identity-replay" };
    assert.equal((await runtime.execute(request)).outcome, "EXECUTED_VERIFIED");
    assert.equal((await runtime.execute(request)).reason, "REPLAY");
    const before = identityWithSubstrate({ authorityStore: grantStore(), acknowledge: ack });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await before.execute({ operation: "save", parameters: params(dir()), signal: controller.signal });
    assert.equal(cancelled.outcome, "CANCELLED_BEFORE_EFFECT");
    assert.equal(before.invocationCount(), 0);
});

test("identity/proposal: proposal is unsigned and never a grant", () => {
    const proposal = identityWithSubstrate().ratificationProposal();
    assert.equal(proposal.capabilityId, CAPABILITY_ID);
    assert.equal(proposal.status, "UNSIGNED_NOT_ACTIVE");
    assert.equal(Object.prototype.hasOwnProperty.call(proposal, "grant"), false);
});

test("identity/composition: unbranded runtime cannot cross the file-store boundary", () => {
    assert.throws(() => createFileIdentityStore(path.join(dir(), "identity.json"), {
        capabilityRuntime: { execute: async () => ({ outcome: "EXECUTED_VERIFIED" }) }
    }), /Manager-composed capability runtime/);
});

test("identity/scope: the evaluated request carries the caller scope", async () => {
    const root = dir();
    const runtime = identityWithSubstrate({ authorityStore: grantStore({ scope: ["device:self"] }), acknowledge: ack });
    const denied = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(denied.denied, true);
    const allowed = await runtime.execute({ operation: "save", scope: ["device:self"], parameters: params(root) });
    assert.equal(allowed.outcome, "EXECUTED_VERIFIED");
});

test("identity/restart-replay: a fresh runtime cannot repeat a durable completed request", async () => {
    const root = dir();
    const replayRoot = path.join(root, "replay");
    const anchorRoot = path.join(root, "anchor");
    const first = identityWithSubstrate({ authorityStore: grantStore(), replayStore: createRollbackResistantLedger({ replayRoot, anchorRoot }), acknowledge: ack });
    const request = { operation: "save", requestId: "restart-replay", parameters: params(root) };
    assert.equal((await first.execute(request)).outcome, "EXECUTED_VERIFIED");
    const second = identityWithSubstrate({ authorityStore: grantStore(), replayStore: createRollbackResistantLedger({ replayRoot, anchorRoot }), acknowledge: ack });
    const replayed = await second.execute(request);
    assert.equal(replayed.reason, "REPLAY");
    assert.equal(second.invocationCount(), 0);
    const changed = await second.execute({ ...request, requestId: "new-request", parameters: { ...params(root), payload: "{\"version\":1,\"devices\":[],\"transactions\":[\"new\"]}" } });
    assert.equal(changed.outcome, "EXECUTED_VERIFIED");
});

test("identity/replay-ledger: corruption fails closed", async () => {
    const root = dir();
    const replayFile = path.join(root, "replay.sqlite");
    fs.writeFileSync(replayFile, "not-json\n");
    const runtime = identityWithSubstrate({ authorityStore: grantStore(), replayStore: createRollbackResistantLedger({ file: replayFile }), acknowledge: ack });
    const result = await runtime.execute({ operation: "save", parameters: params(root) });
    assert.equal(result.reason, "REPLAY_LEDGER_UNAVAILABLE");
    assert.equal(runtime.invocationCount(), 0);
});

test("identity/audit-binding: durable acknowledgement receives exact binding fields", async () => {
    const root = dir();
    let observed;
    const runtime = identityWithSubstrate({
        authorityStore: grantStore({ scope: ["device:self"] }),
        acknowledge(entry) { observed = entry; return { ok: true, receipt: "bound" }; }
    });
    const result = await runtime.execute({ operation: "save", scope: ["device:self"], identity: { principal: "owner" }, parameters: params(root) });
    assert.equal(result.outcome, "EXECUTED_VERIFIED");
    assert.equal(observed.capabilityId, CAPABILITY_ID);
    assert.equal(observed.operation, "save");
    assert.equal(typeof observed.requestDigest, "string");
    assert.deepEqual(observed.scope, ["device:self"]);
    assert.equal(observed.principal, "owner");
    assert.equal(typeof observed.authorityGeneration, "number");
    assert.equal(observed.verificationState, "verified");
});

test("identity/replay-race: independent Node processes have one atomic reservation winner", async () => {
    const root = dir();
    const replayFile = path.join(root, "race.sqlite");
    const readyA = path.join(root, "ready-a");
    const readyB = path.join(root, "ready-b");
    const go = path.join(root, "go");
    const modulePath = path.resolve(__dirname, "../../../src/manager/internal/canonicalReplayLedger.js");
    const code = `const fs=require("node:fs"); const {createCanonicalReplayLedger}=require(${JSON.stringify(modulePath)}); const [db,ready,go]=process.argv.slice(1); fs.writeFileSync(ready,"ready",{flag:"wx"}); while(!fs.existsSync(go)){}; createCanonicalReplayLedger({file:db}).reserve({digest:"race-digest",capabilityId:"race.cap",operation:"run",principal:"owner",scope:[],authorityGeneration:0,driverId:"race-driver"}).then(r=>{process.stdout.write(JSON.stringify(r));process.exit(0);}).catch(e=>{process.stdout.write(JSON.stringify({error:e.message})); process.exit(1);});`;
    const launch = (ready) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", code, replayFile, ready, go], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => err += d);
        child.on("error", reject); child.on("close", code => resolve({ code, out, err }));
    });
    const a = launch(readyA); const b = launch(readyB);
    const deadline = Date.now() + 5000;
    while (!(fs.existsSync(readyA) && fs.existsSync(readyB))) { if (Date.now() > deadline) throw new Error("race children did not rendezvous"); await new Promise(r => setTimeout(r, 5)); }
    fs.writeFileSync(go, "go");
    const results = await Promise.all([a, b]);
    const parsed = results.map((x, i) => {
        if (!x.out) throw new Error(`Child ${i} produced no output. stderr: ${x.err}`);
        try { return JSON.parse(x.out); } catch (e) { throw new Error(`Child ${i} bad JSON: ${x.out}. stderr: ${x.err}`); }
    });
    const reserved = parsed.filter(x => x.reserved === true);
    const replayed = parsed.filter(x => x.reserved === false);
    assert.equal(reserved.length, 1);
    assert.equal(replayed.length, 1);
});

test("identity/replay-integrity: valid SQLite tampering is detected", async () => {
    const root = dir();
    const replayFile = path.join(root, "tamper.sqlite");
    const ledger = createCanonicalReplayLedger({ file: replayFile });
    await ledger.reserve({ digest: "tamper-a", capabilityId: "tamper.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });
    await ledger.transition("tamper-a", "INVOKING", { capabilityId: "tamper.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });
    const sqlite = require("sqlite3");
    const db = new sqlite.Database(replayFile);
    await new Promise((resolve, reject) => db.run("DELETE FROM replay_events WHERE seq=1", e => e ? reject(e) : resolve()));
    db.close();
    const fresh = createCanonicalReplayLedger({ file: replayFile });
    await assert.rejects(() => fresh.reserve({ digest: "tamper-b", capabilityId: "tamper.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" }), /INTEGRITY|ANCHOR/);
});

test("identity/replay-anchor-protection: anchor detects SQLite-only tampering", async () => {
    const root = dir();
    const replayFile = path.join(root, "rollback.sqlite");
    const ledger = createCanonicalReplayLedger({ file: replayFile });
    await ledger.reserve({ digest: "event-1", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });
    
    await ledger.reserve({ digest: "event-2", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });
    
    // Deleting a row from replay_events (without updating anchor) is DETECTED
    const sqlite = require("sqlite3");
    const db = new sqlite.Database(replayFile);
    await new Promise((resolve, reject) => db.run("DELETE FROM replay_events WHERE seq=2", e => e ? reject(e) : resolve()));
    db.close();
    
    const tamperedLedger = createCanonicalReplayLedger({ file: replayFile });
    await assert.rejects(
        () => tamperedLedger.reserve({ digest: "event-3", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" }),
        /ANCHOR_MISMATCH|INTEGRITY/,
        "SQLite row deletion must be detected by anchor mismatch during reserve"
    );
});
