"use strict";

/**
 * W8-IW1 — dual-witness replay safety (audit of 752e773).
 *
 * Invariant under test:
 *   A committed consequential replay state is NOT safely acknowledged unless at
 *   least one ROLLBACK-RESISTANT witness has durably advanced to that head.
 *   When an EXTERNAL anchor is configured it is the only rollback-resistant
 *   witness; the co-located local anchor MUST NOT substitute for it.
 *   If no trusted witness advanced, the ledger fails closed and a later
 *   truncation to the frozen head is still detected.
 *
 * Note: production wires no genuine external anchor, so consequential execution
 * is refused outright (REPLAY_ROLLBACK_UNPROTECTED). The EXTERNAL cases here use
 * a test double of the port.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sqlite3 = require("sqlite3");
const { createCanonicalReplayLedger, STATES } = require("../../../src/manager/internal/canonicalReplayLedger.js");

const WORKTREE = path.resolve(__dirname, "../../..");
const MODULE_PATH = path.resolve(__dirname, "../../../src/manager/internal/canonicalReplayLedger.js");
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "damar-dual-"));
const bind = (digest) => ({ digest, capabilityId: "c", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "d" });

/** Test double of the external rollback-anchor port, with a fault switch. */
function makePort(storeFile) {
    const port = {
        externalBroken: false,
        read() {
            if (!fs.existsSync(storeFile)) return null;
            try { return JSON.parse(fs.readFileSync(storeFile, "utf8")); } catch { return null; }
        },
        commit(seq, token) {
            if (port.externalBroken) throw new Error("external anchor down");
            fs.writeFileSync(storeFile, JSON.stringify({ seq, token }));
        }
    };
    return port;
}

const localSeq = (file) => (fs.existsSync(file + ".anchor") ? JSON.parse(fs.readFileSync(file + ".anchor", "utf8")).seq : null);
const externalSeq = (storeFile) => (fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")).seq : null);
const seals = (file) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.all("SELECT seq FROM replay_events ORDER BY seq", [], (e, r) => { db.close(); e ? reject(e) : resolve(r.map((x) => x.seq)); });
});
const truncateTo = (file, seq) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.run("DELETE FROM replay_events WHERE seq > ?", [seq], (e) => { db.close(); e ? reject(e) : resolve(); });
});
/** Break ONLY the local, co-located anchor write. */
function breakLocal(file) {
    const anchorFile = file + ".anchor";
    const orig = fs.renameSync;
    fs.renameSync = function (src, dst) {
        if (String(dst) === anchorFile) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; }
        return orig.call(fs, src, dst);
    };
    return () => { fs.renameSync = orig; };
}

test("A: external succeeds / local fails -> still protected, no stranded digest", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));

    const restore = breakLocal(file);
    let r = null;
    try { r = await ledger.reserve(bind("B")); } finally { restore(); }
    assert.equal(r.reserved, true, "an EXTERNAL witness is sufficient");
    assert.equal(externalSeq(storeFile), 2, "the external head advanced");
    assert.equal(localSeq(file), 1, "the local anchor is behind (best-effort, heals later)");

    // A DB-only truncation is still caught by the external head.
    await truncateTo(file, 1);
    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await assert.rejects(() => fresh.reserve(bind("B")),
        /REPLAY_ROLLBACK_DETECTED|REPLAY_TRUNCATION_DETECTED|REPLAY_ANCHOR_MISMATCH/);
});

test("B: local succeeds / external fails -> local MUST NOT establish rollback safety", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));

    port.externalBroken = true;
    let err = null;
    try { await ledger.reserve(bind("B")); } catch (e) { err = e; }
    port.externalBroken = false;

    assert.match(String(err && err.message), /REPLAY_HEAD_UNWITNESSED/,
        "a co-located local anchor must not substitute for the external witness");
    assert.equal(externalSeq(storeFile), 1, "the external head did not advance");
    assert.equal(localSeq(file), 1, "the local anchor must NOT advance when the trusted witness failed");

    // A transient witness failure must not brick the ledger for later operations.
    assert.equal((await ledger.reserve(bind("C"))).reserved, true,
        "the ledger must stay usable after a transient witness failure");
});

test("C: BOTH witnesses fail after COMMIT -> fail closed with both diagnostics preserved", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));

    port.externalBroken = true;
    const restore = breakLocal(file);
    let err = null;
    try { await ledger.reserve(bind("B")); } catch (e) { err = e; }
    finally { restore(); port.externalBroken = false; }

    assert.match(String(err && err.message), /REPLAY_HEAD_UNWITNESSED/, "no silent success may be reported");
    assert.match(String(err.message), /external=FAILED/, "external failure must be reported");
    assert.match(String(err.message), /local=skipped/,
        "the local write is deliberately SKIPPED when the trusted witness failed, so it can never get ahead");
    assert.deepEqual(await seals(file), [1],
        "an unwitnessed append must be ROLLED BACK, never left committed beside a frozen head");
});

test("D: BOTH fail on the post-invocation transition -> the effect stays AMBIGUOUS after a coordinated rollback", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));
    await ledger.transition("A", STATES.INVOKING, bind("A")); // the driver may now have run

    port.externalBroken = true;
    const restore = breakLocal(file);
    try { await assert.rejects(() => ledger.transition("A", STATES.EXECUTED_UNVERIFIED, bind("A")), /REPLAY_HEAD_UNWITNESSED/); }
    finally { restore(); port.externalBroken = false; }
    assert.equal((await ledger.lookup("A")).state, STATES.INVOKING,
        "the unwitnessed tail must roll back to the ambiguous state, never to RESERVED");

    // Coordinated attack: delete the event rows AND the co-located marker rows.
    await truncateTo(file, 1);
    const db = new sqlite3.Database(file);
    await new Promise((res, rej) => db.run("DELETE FROM replay_unwitnessed", [], (e) => (e ? rej(e) : res())));
    db.close();

    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await assert.rejects(() => fresh.reserve(bind("A")),
        /REPLAY_ANCHOR_MISMATCH|REPLAY_ROLLBACK_DETECTED|REPLAY_TRUNCATION_DETECTED/,
        "deleting the marker alongside the events must NOT resurrect a witnessed state");
});

/** Seed `A`, then run a REAL child process that dies inside the COMMIT callback,
 *  i.e. after the event is committed but before any witness is persisted. */
async function crashAfterCommit(root) {
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    await createCanonicalReplayLedger({ file, rollbackAnchor: port }).reserve(bind("A"));

    const childCode = `
        const fs = require("node:fs");
        const sqlite3 = require("sqlite3");
        const { createCanonicalReplayLedger } = require(${JSON.stringify(MODULE_PATH)});
        const origRun = sqlite3.Database.prototype.run;
        sqlite3.Database.prototype.run = function (sql, ...rest) {
            const cb = rest[rest.length - 1];
            if (typeof sql === "string" && sql === "COMMIT" && typeof cb === "function") {
                rest[rest.length - 1] = function (...a) { cb.apply(this, a); process.exit(0); };
                return origRun.apply(this, [sql, ...rest]);
            }
            return origRun.apply(this, [sql, ...rest]);
        };
        const storeFile = ${JSON.stringify(storeFile)};
        const port = {
            read() { return fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : null; },
            commit(seq, token) { fs.writeFileSync(storeFile, JSON.stringify({ seq, token })); }
        };
        createCanonicalReplayLedger({ file: ${JSON.stringify(file)}, rollbackAnchor: port })
            .reserve({digest:"B",capabilityId:"c",operation:"run",principal:"owner",scope:[],authorityGeneration:0,driverId:"d"})
            .then(() => process.exit(0))
            .catch(() => process.exit(0));
    `;
    await new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", childCode], { cwd: WORKTREE, stdio: "ignore" });
        child.on("close", resolve);
    });
    return { file, storeFile, port };
}

test("E: REAL process crash after DB COMMIT but before witness persistence fails closed", async () => {
    // (1) Attacker truncates to the frozen head before any recovery -> detected.
    const first = await crashAfterCommit(dir());
    assert.deepEqual(await seals(first.file), [1, 2], "DB COMMIT != SAFE COMPLETION: the row committed");
    assert.equal(externalSeq(first.storeFile), 1, "no witness advanced before the crash");
    await truncateTo(first.file, 1);
    const fresh = createCanonicalReplayLedger({ file: first.file, rollbackAnchor: first.port });
    await assert.rejects(() => fresh.reserve(bind("B")),
        /REPLAY_TRUNCATION_DETECTED|REPLAY_ROLLBACK_DETECTED/,
        "a crashed-but-committed head must still be detectable after a truncation");

    // (2) Without truncation the unacknowledged append is NOT silently retryable:
    // recovery may only reconcile by durably advancing a TRUSTED witness, so the
    // digest stays consumed (fail closed) rather than being freed for a re-run.
    const second = await crashAfterCommit(dir());
    assert.deepEqual(await seals(second.file), [1, 2]);
    const fresh2 = createCanonicalReplayLedger({ file: second.file, rollbackAnchor: second.port });
    assert.equal((await fresh2.reserve(bind("B"))).reserved, false,
        "UNCERTAIN PRIOR EFFECT != SAFE TO RETRY: a crashed-but-committed digest must stay consumed");
    assert.equal(externalSeq(second.storeFile), 2, "recovery acknowledged the head only by advancing the witness");
});

test("F: restart after PARTIAL persistence reconciles the local anchor", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));

    const restore = breakLocal(file);
    try { assert.equal((await ledger.reserve(bind("B"))).reserved, true, "external witness carried it"); }
    finally { restore(); }
    assert.equal(externalSeq(storeFile), 2);
    assert.equal(localSeq(file), 1, "the local anchor is behind");

    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    assert.equal((await fresh.reserve(bind("C"))).reserved, true);
    assert.equal(localSeq(file), 3, "the local anchor healed to the authenticated head");
});

test("G: an external head AHEAD of the DB is detected as rollback", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));
    assert.equal(externalSeq(storeFile), 1);

    await truncateTo(file, 0);
    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await assert.rejects(() => fresh.reserve(bind("B")),
        /REPLAY_ROLLBACK_DETECTED|REPLAY_TRUNCATION_DETECTED|REPLAY_ANCHOR_MISMATCH/);
});

test("H: an external head BEHIND the DB is reconciled forward on the writer path", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));
    await ledger.reserve(bind("B"));
    assert.equal(externalSeq(storeFile), 2);

    fs.writeFileSync(storeFile, JSON.stringify({ seq: 1, token: "stale" }));
    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    assert.equal((await fresh.reserve(bind("C"))).reserved, true);
    assert.equal(externalSeq(storeFile), 3, "a genuinely external anchor cannot be behind, so it is advanced");
});

test("I: a local anchor BEHIND is healed; AHEAD fails closed", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const anchorFile = file + ".anchor";
    const ledger = createCanonicalReplayLedger({ file });
    await ledger.reserve(bind("A"));
    const seq1 = fs.readFileSync(anchorFile, "utf8");
    await ledger.reserve(bind("B"));

    fs.writeFileSync(anchorFile, seq1);
    assert.equal((await ledger.reserve(bind("C"))).reserved, true, "a BEHIND anchor heals on the writer path");
    assert.equal(localSeq(file), 3);

    const seq3 = fs.readFileSync(anchorFile, "utf8");
    await truncateTo(file, 2);
    fs.writeFileSync(anchorFile, seq3);
    const fresh = createCanonicalReplayLedger({ file });
    await assert.rejects(() => fresh.reserve(bind("D")),
        /REPLAY_ANCHOR_MISMATCH|REPLAY_TRUNCATION_DETECTED/);
});

test("J: repeated witness faults across reservations never resurrect or duplicate", async () => {
    const root = dir();
    const file = path.join(root, "replay.sqlite");
    const storeFile = path.join(root, "ext.json");
    const port = makePort(storeFile);
    const ledger = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    await ledger.reserve(bind("A"));

    for (const digest of ["B", "C", "D"]) {
        port.externalBroken = true;
        const restore = breakLocal(file);
        try { await assert.rejects(() => ledger.reserve(bind(digest)), /REPLAY_HEAD_UNWITNESSED/); }
        finally { restore(); port.externalBroken = false; }
    }

    const counts = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file);
        db.all("SELECT digest, COUNT(*) AS n FROM replay_events GROUP BY digest", [], (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
    const byDigest = Object.fromEntries(counts.map((row) => [row.digest, row.n]));
    assert.equal(byDigest.A, 1);
    assert.equal(byDigest.B ?? 0, 0, "an unwitnessed append is rolled back, not left committed");
    assert.equal(byDigest.C ?? 0, 0, "no further event may commit while the head is unacknowledged");
    assert.equal(byDigest.D ?? 0, 0, "no further event may commit while the head is unacknowledged");

    const fresh = createCanonicalReplayLedger({ file, rollbackAnchor: port });
    assert.equal((await fresh.reserve(bind("B"))).reserved, true, "B never executed, so it may proceed once recovered");
    assert.equal((await fresh.reserve(bind("C"))).reserved, true, "C never executed, so it may proceed once recovered");
    assert.equal((await fresh.reserve(bind("D"))).reserved, true, "D never executed, so it may proceed once recovered");
});
