"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCanonicalReplayLedger, STATES } = require("../../../src/manager/internal/canonicalReplayLedger");

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "damar-crash-"));

test("crash-recovery: RESERVED state after restart prevents duplicate physical effect", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "crash-reserved", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    // Process 1: reserve but "crash" before invoking
    const result1 = await ledger1.reserve(binding);
    assert.equal(result1.reserved, true);
    // Simulate crash here - no transition to INVOKING
    
    // Process 2: restart and attempt same request
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const result2 = await ledger2.reserve(binding);
    assert.equal(result2.reserved, false, "restart must recognize RESERVED state");
    assert.equal(result2.prior.state, STATES.RESERVED);
});

test("crash-recovery: INVOKING state after restart preserves ambiguity", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-invoking.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "crash-invoking", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    await ledger1.transition("crash-invoking", STATES.INVOKING, binding);
    // Simulate crash after INVOKING but before EXECUTED_UNVERIFIED
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const lookup = await ledger2.lookup("crash-invoking");
    assert.equal(lookup.state, STATES.INVOKING, "INVOKING state must be durable across restart");
    
    // Attempt to reserve again should be rejected
    const result = await ledger2.reserve(binding);
    assert.equal(result.reserved, false);
    assert.equal(result.prior.state, STATES.INVOKING, "INVOKING is terminal for reservation");
});

test("crash-recovery: EXECUTED_UNVERIFIED to COMPLETED_VERIFIED transition survives restart", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-unverified.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "crash-unverified", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    await ledger1.transition("crash-unverified", STATES.INVOKING, binding);
    await ledger1.transition("crash-unverified", STATES.EXECUTED_UNVERIFIED, binding);
    // Crash before COMPLETED_VERIFIED
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const lookup = await ledger2.lookup("crash-unverified");
    assert.equal(lookup.state, STATES.EXECUTED_UNVERIFIED);
    
    // Can transition to COMPLETED_VERIFIED after restart
    await ledger2.transition("crash-unverified", STATES.COMPLETED_VERIFIED, binding);
    const final = await ledger2.lookup("crash-unverified");
    assert.equal(final.state, STATES.COMPLETED_VERIFIED);
});

test("crash-recovery: AMBIGUOUS state is permanent and prevents retry", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-ambiguous.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "crash-ambiguous", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    await ledger1.transition("crash-ambiguous", STATES.INVOKING, binding);
    await ledger1.transition("crash-ambiguous", STATES.AMBIGUOUS, binding);
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const lookup = await ledger2.lookup("crash-ambiguous");
    assert.equal(lookup.state, STATES.AMBIGUOUS);
    
    // Cannot reserve or retry an AMBIGUOUS request
    const result = await ledger2.reserve(binding);
    assert.equal(result.reserved, false);
    assert.equal(result.prior.state, STATES.AMBIGUOUS);
});

test("crash-recovery: CANCELLED_BEFORE_EFFECT prevents any invocation", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-cancelled.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "crash-cancelled", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    await ledger1.transition("crash-cancelled", STATES.CANCELLED_BEFORE_EFFECT, binding);
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const lookup = await ledger2.lookup("crash-cancelled");
    assert.equal(lookup.state, STATES.CANCELLED_BEFORE_EFFECT);
    
    const result = await ledger2.reserve(binding);
    assert.equal(result.reserved, false);
    assert.equal(result.prior.state, STATES.CANCELLED_BEFORE_EFFECT);
});

test("crash-recovery: binding mismatch on restart is detected", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-binding.sqlite");
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding1 = { digest: "same-digest", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding1);
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    const binding2 = { digest: "same-digest", capabilityId: "test.cap", operation: "run", principal: "DIFFERENT", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await assert.rejects(
        () => ledger2.reserve(binding2),
        /BINDING_MISMATCH/,
        "different binding for same digest must fail"
    );
});

test("crash-recovery: anchor corruption after restart fails closed", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-anchor.sqlite");
    const anchorFile = replayFile + ".anchor";
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "anchor-test", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    
    // Corrupt the anchor file
    fs.writeFileSync(anchorFile, JSON.stringify({ seq: 1, eventHmac: "fake", anchorHmac: "corrupted" }));
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    await assert.rejects(
        () => ledger2.reserve({ digest: "new-digest", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" }),
        /ANCHOR_CORRUPT/,
        "corrupted anchor must fail closed"
    );
});

test("crash-recovery: missing anchor with existing events fails closed", async () => {
    const root = dir();
    const replayFile = path.join(root, "crash-missing-anchor.sqlite");
    const anchorFile = replayFile + ".anchor";
    const ledger1 = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "missing-anchor", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };
    
    await ledger1.reserve(binding);
    
    // Delete the anchor file
    fs.unlinkSync(anchorFile);
    
    const ledger2 = createCanonicalReplayLedger({ file: replayFile });
    await assert.rejects(
        () => ledger2.lookup("missing-anchor"),
        /ANCHOR_MISMATCH/,
        "missing anchor with events must fail"
    );
});

test("anchor-durability: anchor is written, valid, and advances across transitions", async () => {
    const root = dir();
    const replayFile = path.join(root, "anchor-durable.sqlite");
    const anchorFile = replayFile + ".anchor";
    const ledger = createCanonicalReplayLedger({ file: replayFile });
    const binding = { digest: "anchor-durable", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" };

    await ledger.reserve(binding);
    const afterReserve = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
    assert.equal(afterReserve.seq, 1, "anchor seq must be the number of appended events");
    assert.equal(typeof afterReserve.eventHmac, "string");
    assert.equal(typeof afterReserve.anchorHmac, "string");

    await ledger.transition("anchor-durable", STATES.INVOKING, binding);
    const afterInvoking = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
    assert.equal(afterInvoking.seq, 2, "anchor must advance with each appended event");
    assert.notEqual(afterInvoking.eventHmac, afterReserve.eventHmac);

    // The freshly written anchor must validate on a fresh reader.
    const fresh = createCanonicalReplayLedger({ file: replayFile });
    const current = await fresh.lookup("anchor-durable");
    assert.equal(current.state, STATES.INVOKING);
});

test("anchor-durability: truncated/partial anchor fails closed", async () => {
    const root = dir();
    const replayFile = path.join(root, "anchor-partial.sqlite");
    const anchorFile = replayFile + ".anchor";
    const ledger = createCanonicalReplayLedger({ file: replayFile });
    await ledger.reserve({ digest: "partial", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });

    // Simulate a crash mid-write: a partial (non-JSON) anchor on disk.
    const full = fs.readFileSync(anchorFile, "utf8");
    fs.writeFileSync(anchorFile, full.slice(0, Math.floor(full.length / 2)));

    const fresh = createCanonicalReplayLedger({ file: replayFile });
    await assert.rejects(
        () => fresh.reserve({ digest: "partial-2", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" }),
        /ANCHOR_CORRUPT|ANCHOR_MISMATCH/,
        "a partial anchor must fail closed, never be accepted"
    );
});

test("anchor-durability: anchor write leaves no temp artifact behind", async () => {
    const root = dir();
    const replayFile = path.join(root, "anchor-inplace.sqlite");
    const anchorFile = replayFile + ".anchor";
    const ledger = createCanonicalReplayLedger({ file: replayFile });
    await ledger.reserve({ digest: "inplace", capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });
    await ledger.transition("inplace", STATES.INVOKING, { capabilityId: "test.cap", operation: "run", principal: "owner", scope: [], authorityGeneration: 0, driverId: "driver" });

    assert.equal(fs.existsSync(anchorFile), true, "anchor must exist after write");
    assert.equal(fs.existsSync(anchorFile + ".tmp"), false, "no temp anchor file may remain after a successful write");
});
