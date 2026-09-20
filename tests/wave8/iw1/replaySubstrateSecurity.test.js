"use strict";

/**
 * W8-IW1 — replay substrate security regressions for the audit of f73b01b.
 *
 * Covers:
 *   P0-1  replay state is derived ONLY from authenticated replay_events;
 *         there is no independent trusted replay_current cache.
 *   P0-2  consequential execution requires a rollback-resistant substrate, and
 *         a whole-local-state rollback to an earlier consistent snapshot is
 *         detected by the EXTERNAL anchor and fails closed.
 *   P2    the request digest uses ONE canonical serializer and refuses
 *         ambiguous/hostile values (NaN/Infinity/BigInt/Date/undefined).
 *   P1-1  the anchor write path is durable and leaves no partial temp artifact.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3");

const { createCanonicalReplayLedger } = require("../../../src/manager/internal/canonicalReplayLedger.js");
const { CanonicalCapabilityExecution, OUTCOME, REFUSAL } = require("../../../src/manager/internal/canonicalCapabilityExecution.js");
const { loadAndEvaluateAuthority } = require("../../../src/authority/evaluate.js");
const { createRollbackResistantLedger, createFileRollbackAnchor } = require("../../helpers/rollbackSubstrate");

const CAP = "coding.lsp.query";
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "damar-substrate-"));
const bind = (digest) => ({ digest, capabilityId: "c", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "d" });
const all = (db, sql) => new Promise((res, rej) => db.all(sql, [], (e, r) => e ? rej(e) : res(r)));

function grantStore(capabilityId = CAP) {
    return {
        async getCapability(id) {
            if (id !== capabilityId) return null;
            return { capabilityId: id, status: "ACTIVE", generation: 0, payload: {
                subject: "owner", capabilityId: id, kind: "root", actions: ["execute"], scope: [],
                allowedPurposes: [], restrictions: { kind: "unrestricted" }, maxExecutions: null,
                identityBinding: null, notBefore: null, expiresAt: null, issuedAt: new Date().toISOString()
            } };
        },
        async getGeneration() { return 0; },
        async countConsumption() { return 0; }
    };
}

async function authorized(capabilityId = CAP) {
    return loadAndEvaluateAuthority(grantStore(capabilityId), { capabilityId, action: "execute", scope: [] });
}

/** Bridge with a single observable driver; substrate is caller-chosen. */
function bridgeWith({ replayStore = null, requireRollbackResistance = true, consequential = true } = {}) {
    const bridge = new CanonicalCapabilityExecution({ replayStore, requireRollbackResistance });
    const calls = [];
    bridge.registerCapability({
        capabilityId: CAP,
        operation: "execute",
        consequential,
        driver: async () => { calls.push(1); return { changed: true }; }
    });
    bridge.registerVerifier(CAP, async () => ({ checks: [{ name: "ok", passed: true }] }));
    bridge.installAuditAcknowledger(() => ({ ok: true, receipt: "substrate-ack" }));
    return { bridge, calls };
}

// ---------------------------------------------------------------------------
// P0-1 — replay_current is not a trusted source
// ---------------------------------------------------------------------------

test("P0-1: no replay_current table exists; replay truth is authenticated events only", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));

    const db = new sqlite3.Database(file);
    const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table'");
    db.close();
    const names = tables.map(t => t.name);
    assert.equal(names.includes("replay_current"), false, "replay_current must not exist as a trusted source");
    assert.equal(names.includes("replay_events"), true, "replay_events is the authenticated history");
});

test("P0-1: deleting an authenticated event row fails closed (no resurrect)", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    await ledger.transition("A", "INVOKING", bind("A"));

    const db = new sqlite3.Database(file);
    await new Promise((res, rej) => db.run("DELETE FROM replay_events WHERE seq=1", e => e ? rej(e) : res()));
    db.close();

    const fresh = createCanonicalReplayLedger({ file });
    await assert.rejects(
        () => fresh.reserve(bind("A")),
        /ANCHOR_MISMATCH|INTEGRITY/,
        "removing authenticated history must fail closed, never allow re-reservation"
    );
});

test("P0-1: a consumed digest is refused after a fresh restart (no duplicate)", async () => {
    const root = dir();
    const replayRoot = path.join(root, "replay");
    const anchorRoot = path.join(root, "anchor");
    const first = createRollbackResistantLedger({ replayRoot, anchorRoot });
    assert.equal((await first.reserve(bind("A"))).reserved, true);

    const second = createRollbackResistantLedger({ replayRoot, anchorRoot });
    const again = await second.reserve(bind("A"));
    assert.equal(again.reserved, false);
    assert.equal(again.prior.state, "RESERVED");
});

// ---------------------------------------------------------------------------
// P0-2 — rollback resistance + fail-closed consequential gate
// ---------------------------------------------------------------------------

test("P0-2: whole-state rollback to an earlier consistent snapshot is detected and refused", async () => {
    const root = dir();
    const replayRoot = path.join(root, "replay");
    const anchorRoot = path.join(root, "anchor");

    const l1 = createRollbackResistantLedger({ replayRoot, anchorRoot });
    await l1.reserve(bind("X"));                 // S0: X consumed, A absent
    const s0 = new Map();
    for (const f of fs.readdirSync(replayRoot)) s0.set(f, fs.readFileSync(path.join(replayRoot, f)));

    await l1.reserve(bind("A"));                 // S1: A consumed

    // Restore the S0 snapshot into a fresh replay domain that shares the SAME
    // external anchor (which was never rolled back).
    const rolledRoot = path.join(root, "replay-rolled-back");
    fs.mkdirSync(rolledRoot, { recursive: true });
    for (const [f, bytes] of s0) fs.writeFileSync(path.join(rolledRoot, f), bytes);

    const l2 = createRollbackResistantLedger({ replayRoot: rolledRoot, anchorRoot });
    await assert.rejects(
        () => l2.reserve(bind("A")),
        /REPLAY_ROLLBACK_DETECTED|ANCHOR_MISMATCH|INTEGRITY/,
        "a consumed request must not become replayable after a coordinated rollback"
    );
});

test("P0-2: consequential execution refuses without a rollback-resistant substrate", async () => {
    const { bridge, calls } = bridgeWith({ replayStore: null });
    const result = await bridge.execute({ capabilityId: CAP, operation: "execute", evaluation: await authorized() });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.REPLAY_ROLLBACK_UNPROTECTED);
    assert.equal(result.effectInvoked, false);
    assert.equal(calls.length, 0);
});

test("P0-2: consequential execution refuses a local-only (rollbackResistance=NONE) store", async () => {
    const root = dir();
    const local = createCanonicalReplayLedger({ file: path.join(root, "local.sqlite") });
    assert.equal(local.rollbackResistance, "NONE");
    const { bridge, calls } = bridgeWith({ replayStore: local });
    const result = await bridge.execute({ capabilityId: CAP, operation: "execute", evaluation: await authorized() });
    assert.equal(result.reason, REFUSAL.REPLAY_ROLLBACK_UNPROTECTED);
    assert.equal(calls.length, 0);
});

test("P0-2: consequential execution proceeds with an EXTERNAL substrate exactly once", async () => {
    const { bridge, calls } = bridgeWith({ replayStore: createRollbackResistantLedger() });
    const first = await bridge.execute({ capabilityId: CAP, operation: "execute", evaluation: await authorized() });
    assert.equal(first.outcome, OUTCOME.EXECUTED_VERIFIED);
    assert.equal(calls.length, 1);
    const second = await bridge.execute({ capabilityId: CAP, operation: "execute", evaluation: await authorized() });
    assert.equal(second.reason, REFUSAL.REPLAY);
    assert.equal(calls.length, 1, "replay must not duplicate the physical effect");
});

// ---------------------------------------------------------------------------
// P2 — canonical digest domain
// ---------------------------------------------------------------------------

test("P2: digest refuses ambiguous and hostile values instead of encoding them", () => {
    const bridge = new CanonicalCapabilityExecution();
    const d = (parameters) => bridge.requestDigest({ capabilityId: CAP, operation: "execute", parameters });
    for (const value of [NaN, Infinity, -Infinity, 1n, new Date(0), () => {}, Symbol("s"), new Proxy({}, {})]) {
        assert.throws(() => d(value), /CanonicalizationError|unsupported|non-finite|Proxy/i, `must refuse: ${String(value)}`);
    }
    // Absent and null are the same canonical value by design (deterministic,
    // not ambiguous).
    assert.equal(d(undefined), d(null));
    // Semantically distinct values must not collide into one digest.
    assert.notEqual(d({ a: 1, b: 2 }), d({ a: 2, b: 1 }));
    assert.equal(d({ a: 1, b: 2 }), d({ b: 2, a: 1 }), "key order must not change the digest");
});

test("P2: bridge refuses non-canonical parameters before reservation or driver", async () => {
    const { bridge, calls } = bridgeWith({ consequential: false });
    const result = await bridge.execute({ capabilityId: CAP, operation: "execute", parameters: { n: NaN }, evaluation: await authorized() });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.NON_CANONICAL_REQUEST);
    assert.equal(result.effectInvoked, false);
    assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// P1-2 — consequential production families cannot fall back to in-memory state
// ---------------------------------------------------------------------------

test("P1-2: coding runtime without a persistent substrate refuses consequential execution", async () => {
    const { createCodingCapabilityRuntime } = require("../../../src/manager/internal/codingCapabilities.js");
    const runtime = createCodingCapabilityRuntime({
        authorityStore: grantStore("coding.git.read"),
        acknowledge: () => ({ ok: true, receipt: "p12" })
    });
    const result = await runtime.execute({ capabilityId: "coding.git.read", operation: "diff", parameters: { args: [] } });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.REPLAY_ROLLBACK_UNPROTECTED);
    assert.equal(runtime.invocationCount("coding.git.read"), 0, "no driver may run without a rollback-resistant substrate");
});

test("P1-2: cli runtime without a persistent substrate refuses consequential execution", async () => {
    const { createCliCapabilityRuntime } = require("../../../src/manager/internal/cliCapabilities.js");
    const runtime = createCliCapabilityRuntime({
        authorityStore: grantStore("cli.daemon.start"),
        acknowledge: () => ({ ok: true, receipt: "p12" })
    });
    const result = await runtime.execute({ capabilityId: "cli.daemon.start", operation: "serve", parameters: {} });
    assert.equal(result.outcome, OUTCOME.REFUSED);
    assert.equal(result.reason, REFUSAL.REPLAY_ROLLBACK_UNPROTECTED);
});

// ---------------------------------------------------------------------------
// P1 (audit of b7738ef) — anchor/commit ordering must never poison the ledger
// ---------------------------------------------------------------------------

test("P1: a failed COMMIT leaves no anchor ahead of committed history, and the ledger is not poisoned", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";

    const origRun = sqlite3.Database.prototype.run;
    let failCommitOnce = true;
    sqlite3.Database.prototype.run = function (sql, ...rest) {
        if (failCommitOnce && typeof sql === "string" && sql === "COMMIT") {
            failCommitOnce = false;
            const cb = rest[rest.length - 1];
            if (typeof cb === "function") { process.nextTick(() => cb(new Error("simulated failure before COMMIT"))); return this; }
        }
        return origRun.apply(this, [sql, ...rest]);
    };
    let firstError = null;
    try {
        const l1 = createCanonicalReplayLedger({ file });
        try { await l1.reserve(bind("A")); } catch (e) { firstError = e; }
    } finally {
        sqlite3.Database.prototype.run = origRun;
    }
    assert.ok(firstError, "the simulated COMMIT failure must surface");

    // Nothing was committed and no anchor was written ahead of history.
    assert.equal(fs.existsSync(anchorFile), false, "anchors are written only AFTER a successful COMMIT");

    // The ledger must remain usable for unrelated digests (no permanent denial).
    const l2 = createCanonicalReplayLedger({ file });
    const after = await l2.reserve(bind("B"));
    assert.equal(after.reserved, true, "a crashed COMMIT must not poison the whole ledger");
});

test("P1: an anchor BEHIND the authenticated chain is repaired forward, not treated as tamper", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const anchorAfterFirst = fs.readFileSync(anchorFile, "utf8");   // seq 1
    await ledger.reserve(bind("B"));                                 // seq 2

    // Simulate our own post-commit anchor write failing: anchor lags the chain.
    fs.writeFileSync(anchorFile, anchorAfterFirst);

    const fresh = createCanonicalReplayLedger({ file });
    const c = await fresh.reserve(bind("C"));
    assert.equal(c.reserved, true, "a lagging anchor must be repaired, not poison the ledger");
    // The already-consumed digests stay consumed.
    assert.equal((await fresh.reserve(bind("A"))).reserved, false);
    assert.equal((await fresh.reserve(bind("B"))).reserved, false);
});

// ---------------------------------------------------------------------------
// P1 (audit of 52e4fe4) — a mid-write anchor failure must not corrupt the anchor
// ---------------------------------------------------------------------------

function rawRows(file) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(file);
        db.all("SELECT * FROM replay_events ORDER BY seq", [], (e, r) => { db.close(); e ? rej(e) : res(r); });
    });
}

test("P1: a mid-write failure of the anchor write never truncates the live anchor", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));                 // anchor at seq 1
    const before = fs.readFileSync(anchorFile, "utf8");

    const origWrite = fs.writeSync;
    let failedOnce = false;
    fs.writeSync = function (fd, data, ...rest) {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : (typeof data === "string" ? data : "");
        if (!failedOnce && text.includes("anchorHmac")) {
            failedOnce = true;
            throw new Error("simulated disk full");
        }
        return origWrite.call(fs, fd, data, ...rest);
    };
    let outcome = null;
    try { outcome = await ledger.reserve(bind("B")); } finally { fs.writeSync = origWrite; }
    // A post-commit anchor-persist failure must NOT reject a landed reservation.
    assert.equal(outcome.reserved, true, "a committed reservation must survive an anchor-write failure");

    // The live anchor must be untouched (the previous valid payload), not 0 bytes.
    assert.equal(fs.readFileSync(anchorFile, "utf8"), before, "a failed anchor write must not truncate the live anchor");

    // And the ledger must not be poisoned.
    const fresh = createCanonicalReplayLedger({ file });
    assert.equal((await fresh.reserve(bind("C"))).reserved, true, "ledger must self-heal, not deny forever");
    assert.equal((await fresh.reserve(bind("A"))).reserved, false, "consumed digests stay consumed");
    assert.equal((await fresh.reserve(bind("B"))).reserved, false, "the committed digest stays consumed even though its anchor write failed");
});

test("P1: a non-throwing SHORT write of the anchor leaves the live anchor intact, and progressing short writes complete", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const before = fs.readFileSync(anchorFile, "utf8");

    // (a) a STUCK short write returns fewer/zero bytes WITHOUT throwing.
    const origWrite = fs.writeSync;
    let stuck = false;
    fs.writeSync = function (fd, data, ...rest) {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : (typeof data === "string" ? data : "");
        if (!stuck && text.includes("anchorHmac")) { stuck = true; return 0; }
        return origWrite.call(fs, fd, data, ...rest);
    };
    let outcome = null;
    try { outcome = await ledger.reserve(bind("B")); } finally { fs.writeSync = origWrite; }
    assert.equal(outcome.reserved, true, "the committed reservation must survive a short-write failure");
    assert.equal(fs.readFileSync(anchorFile, "utf8"), before, "the live anchor must never be corrupted by a short write");

    const fresh = createCanonicalReplayLedger({ file });
    assert.equal((await fresh.reserve(bind("C"))).reserved, true, "ledger must self-heal after a short-write failure");

    // (b) a PROGRESSING short write must be completed, never truncated.
    const root2 = dir();
    const file2 = path.join(root2, "replay.sqlite");
    const ledger2 = createCanonicalReplayLedger({ file: file2 });
    const origWrite2 = fs.writeSync;
    let once = false;
    fs.writeSync = function (fd, data, ...rest) {
        if (!once && Buffer.isBuffer(data) && data.toString("utf8").includes("anchorHmac")) {
            once = true;
            const half = data.slice(0, Math.floor(data.length / 2));
            return origWrite2.call(fs, fd, half, 0, half.length);
        }
        return origWrite2.call(fs, fd, data, ...rest);
    };
    try { await ledger2.reserve(bind("Z")); } finally { fs.writeSync = origWrite2; }
    const anchor2 = JSON.parse(fs.readFileSync(file2 + ".anchor", "utf8"));
    assert.equal(anchor2.seq, 1, "a progressing short write must be completed into a valid anchor");
});

test("P2: a lookup reading a stale EMPTY row snapshot alongside a fresh anchor retries", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));                 // seq 1; anchor written

    const origAll = sqlite3.Database.prototype.all;
    let injected = false;
    sqlite3.Database.prototype.all = function (sql, params, cb) {
        if (!injected && typeof sql === "string" && sql.includes("replay_events")) {
            injected = true;
            process.nextTick(() => cb(null, []));     // stale EMPTY view
            return this;
        }
        return origAll.apply(this, [sql, params, cb]);
    };
    try {
        const r = await ledger.lookup("A");
        assert.equal(r.state, "RESERVED", "a stale-empty read must not be misreported as tamper");
    } finally {
        sqlite3.Database.prototype.all = origAll;
    }
});

test("P2: a lookup reading a stale row snapshot alongside a fresh anchor retries instead of reporting tamper", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));                 // seq 1
    const staleRows = await rawRows(file);           // snapshot with 1 row
    await ledger.reserve(bind("B"));                 // seq 2; anchor advanced

    const origAll = sqlite3.Database.prototype.all;
    let injected = false;
    sqlite3.Database.prototype.all = function (sql, params, cb) {
        if (!injected && typeof sql === "string" && sql.includes("replay_events")) {
            injected = true;
            process.nextTick(() => cb(null, staleRows));
            return this;
        }
        return origAll.apply(this, [sql, params, cb]);
    };
    try {
        const r = await ledger.lookup("A");
        assert.equal(r.state, "RESERVED", "a benign stale-read straddle must not be misreported as tamper");
    } finally {
        sqlite3.Database.prototype.all = origAll;
    }
});

test("P1: an over-reported writeSync count is rejected and never corrupts the live anchor", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const before = fs.readFileSync(anchorFile, "utf8");

    const origWrite = fs.writeSync;
    let inflated = false;
    fs.writeSync = function (fd, data, ...rest) {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : (typeof data === "string" ? data : "");
        if (!inflated && text.includes("anchorHmac")) { inflated = true; return 999999; }
        return origWrite.call(fs, fd, data, ...rest);
    };
    let outcome = null;
    try { outcome = await ledger.reserve(bind("B")); } finally { fs.writeSync = origWrite; }
    assert.equal(outcome.reserved, true, "the committed reservation must survive an over-reported write count");
    assert.equal(fs.readFileSync(anchorFile, "utf8"), before, "the live anchor must be intact");

    const fresh = createCanonicalReplayLedger({ file });
    assert.equal((await fresh.reserve(bind("C"))).reserved, true, "ledger must self-heal");
});

test("P1: a failed anchor write leaves no temp artifact behind", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));

    const origWrite = fs.writeSync;
    let stuck = false;
    fs.writeSync = function (fd, data, ...rest) {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : "";
        if (!stuck && text.includes("anchorHmac")) { stuck = true; return 0; }
        return origWrite.call(fs, fd, data, ...rest);
    };
    try { await ledger.reserve(bind("B")); } catch { /* expected */ }
    finally { fs.writeSync = origWrite; }

    const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], "no temp anchor artifact may remain after a failed write");
});

test("P1: read-only lookup never writes the anchor (no unlocked self-heal)", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const anchorSeq1 = fs.readFileSync(anchorFile, "utf8");
    await ledger.reserve(bind("B"));                 // anchor at seq 2
    fs.writeFileSync(anchorFile, anchorSeq1);        // force a BEHIND state

    const after = await ledger.lookup("A");
    assert.equal(after.state, "RESERVED");
    assert.equal(fs.readFileSync(anchorFile, "utf8"), anchorSeq1, "lookup must not rewrite the anchor");
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes(".tmp")), [], "no temp artifact from a read");
});

test("P1: a transient rename failure is retried, and a persistent one never strands the digest", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));

    // (a) a transient EPERM is retried so the anchor still advances.
    const origRename = fs.renameSync;
    let failures = 1;
    fs.renameSync = function (src, dst) {
        if (failures > 0 && String(dst) === anchorFile) { failures--; const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
        return origRename.call(fs, src, dst);
    };
    try { assert.equal((await ledger.reserve(bind("B"))).reserved, true); }
    finally { fs.renameSync = origRename; }
    assert.equal(JSON.parse(fs.readFileSync(anchorFile, "utf8")).seq, 2, "the rename retry must advance the anchor");

    // (b) a persistent rename failure must not strand the committed reservation.
    const origRename2 = fs.renameSync;
    fs.renameSync = function (src, dst) {
        if (String(dst) === anchorFile) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; }
        return origRename2.call(fs, src, dst);
    };
    let r2 = null;
    try { r2 = await ledger.reserve(bind("C")); } finally { fs.renameSync = origRename2; }
    assert.equal(r2.reserved, true, "a persistently failing anchor write must not strand the digest");
    assert.equal((await ledger.lookup("C")).state, "RESERVED", "the committed digest must be observable");
});

test("P2: concurrent cold starts on a brand-new file never surface a raw SQLITE_BUSY", async () => {
    const root = dir();
    const file = path.join(root, "cold.sqlite");
    const modulePath = path.resolve(__dirname, "../../../src/manager/internal/canonicalReplayLedger.js");
    const spawnOne = (i) => new Promise((resolve) => {
        const code = `const {createCanonicalReplayLedger}=require(${JSON.stringify(modulePath)});`
            + `createCanonicalReplayLedger({file:${JSON.stringify(file)}})`
            + `.reserve({digest:"d"+${i},capabilityId:"c",operation:"run",principal:"owner",scope:[],authorityGeneration:0,driverId:"d"})`
            + `.then(r=>{process.stdout.write(JSON.stringify({ok:true,r}));process.exit(0);})`
            + `.catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message)}));process.exit(0);});`;
        const child = require("node:child_process").spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: "unparsable:" + out }); } });
    });

    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => spawnOne(i)));
    const rawBusy = results.filter((r) => !r.ok && /SQLITE_BUSY/.test(r.error));
    assert.deepEqual(rawBusy, [], "no raw SQLITE_BUSY may surface from a cold start");
    assert.equal(results.filter((r) => r.ok && r.r.reserved === true).length, 6, "each distinct digest reserves exactly once");
});

test("P1: a persistently failing anchor heal does not block unrelated reservations", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const anchorSeq1 = fs.readFileSync(anchorFile, "utf8");
    await ledger.reserve(bind("B"));
    fs.writeFileSync(anchorFile, anchorSeq1);        // force a BEHIND state

    const origRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
        if (String(dst) === anchorFile) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; }
        return origRename.call(fs, src, dst);
    };
    try {
        // A brand-new digest must still reserve; an unhealable anchor must never
        // surface a raw error or deny new reservations.
        assert.equal((await ledger.reserve(bind("C"))).reserved, true, "an unhealable anchor must not block new reservations");
        // Read-only lookup must not throw either.
        assert.equal((await ledger.lookup("A")).state, "RESERVED");
    } finally { fs.renameSync = origRename; }

    // Once the write path recovers, the next writer heals the anchor.
    assert.equal((await ledger.reserve(bind("D"))).reserved, true);
    assert.equal(JSON.parse(fs.readFileSync(anchorFile, "utf8")).seq, 4, "the anchor must heal once the write path recovers");
});

// ---------------------------------------------------------------------------
// P1-1 — anchor durability contract
// ---------------------------------------------------------------------------

test("P1-1: anchor is written durably and leaves no partial temp artifact", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    await ledger.transition("A", "INVOKING", bind("A"));

    const anchor = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
    assert.equal(anchor.seq, 2);
    assert.equal(typeof anchor.anchorHmac, "string");
    assert.equal(fs.existsSync(anchorFile + ".tmp"), false, "no temp anchor may remain");
});

test("P1-1: a partial (crash-truncated) anchor fails closed", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));

    const full = fs.readFileSync(anchorFile, "utf8");
    fs.writeFileSync(anchorFile, full.slice(0, Math.floor(full.length / 2)));

    const fresh = createCanonicalReplayLedger({ file });
    await assert.rejects(() => fresh.reserve(bind("B")), /ANCHOR_CORRUPT|ANCHOR_MISMATCH/);
});

test("P1-1: the rollback anchor port persists durably and round-trips", () => {
    const root = dir();
    const port = createFileRollbackAnchor(root);
    assert.equal(port.read(), null);
    port.commit(3, "token-abc");
    assert.deepEqual(port.read(), { seq: 3, token: "token-abc" });
});
