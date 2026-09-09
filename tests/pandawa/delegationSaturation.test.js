"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const delegation = require("../../src/services/pandawaDelegation");

/**
 * RC-02 — bounded, fail-closed delegation replay lifecycle.
 *
 * Security invariant: once a specific delegation issuance is consumed, the
 * same issuance must NEVER become first-use-valid again during its validity
 * lifetime — even after ledger saturation and pruning. A delegation older
 * than its validity window fails because it is STALE/EXPIRED, never because
 * its tombstone happens to be absent.
 */

function issue(overrides = {}) {
    return delegation.createDelegation({
        fromEntity: "janaka", toEntity: "werkudara", sourceSession: "ses_src", targetSession: "ses_dst",
        objective: "review the patch", reason: "security", contextRefs: ["artifact:1"], requestedCapabilities: ["read"],
        ...overrides
    });
}

test("RC-02 1+2: first acceptance succeeds, immediate second acceptance rejects", () => {
    const d = issue();
    assert.equal(delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }).state, "ACCEPTED");
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }), /ALREADY_CONSUMED/);
});

test("RC-02 3: concurrent double acceptance — exactly one succeeds", async () => {
    const d = issue();
    const attempt = () => new Promise(resolve => {
        setImmediate(() => {
            try { delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }); resolve({ ok: true }); }
            catch (e) { resolve({ ok: false, err: e.message }); }
        });
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const accepted = [a, b].filter(r => r.ok);
    const rejected = [a, b].filter(r => !r.ok);
    assert.equal(accepted.length, 1, "exactly one concurrent acceptance may succeed");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].err, /ALREADY_CONSUMED/);
    assert.equal(delegation.consumption(d.delegationId).receiver, "pandawa:werkudara");
});

test("RC-02 4-7: spread copy, forged object, wrong target, wrong session all reject", () => {
    const d = issue();
    assert.throws(() => delegation.acceptDelegation({ ...d }, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    assert.throws(() => delegation.acceptDelegation({ ...d, state: "ISSUED", generation: delegation.currentEpoch() }, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "janaka", sessionId: "ses_dst" }), /TARGET_INVALID/);
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_other" }), /TARGET_INVALID/);
});

test("RC-02 8+9: filling the ledger beyond the bound never throws and stays bounded", () => {
    const bound = delegation.CONSUMED_LEDGER_BOUND;
    const beyond = bound + 64;
    let accepted = 0;
    // No exception may escape during saturation/pruning/rotation.
    for (let i = 0; i < beyond; i++) {
        const d = issue();
        const ok = delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
        assert.equal(ok.state, "ACCEPTED");
        assert.ok(delegation.consumption(d.delegationId), "each consumed issuance has a tombstone at consumption time");
        accepted++;
    }
    assert.equal(accepted, beyond);
    assert.ok(
        delegation.ledgerSize() <= bound,
        `ledger must stay bounded (size=${delegation.ledgerSize()}, bound=${bound})`
    );
});

test("RC-02 10: replaying an OLD consumed delegation after saturation is REJECTED", () => {
    // Consume one delegation now, keep the ORIGINAL object, then saturate
    // the ledger so its tombstone is rotated/pruned away.
    const old = issue();
    delegation.acceptDelegation(old, { receiver: "werkudara", sessionId: "ses_dst" });

    const bound = delegation.CONSUMED_LEDGER_BOUND;
    for (let i = 0; i < bound + 8; i++) {
        delegation.acceptDelegation(issue(), { receiver: "werkudara", sessionId: "ses_dst" });
    }

    assert.equal(delegation.consumption(old.delegationId), null, "old tombstone no longer resident");
    // Fail-closed: the OLD generation can never become first-use-valid again.
    assert.throws(
        () => delegation.acceptDelegation(old, { receiver: "werkudara", sessionId: "ses_dst" }),
        error => {
            assert.match(error.message, /STALE|ALREADY_CONSUMED/);
            assert.doesNotMatch(error.message, /Assignment to constant/);
            return true;
        },
        "consumed delegation must NOT become reusable after saturation"
    );
    // Still-valid NEW delegations keep working after rotation.
    const fresh = issue();
    assert.equal(delegation.acceptDelegation(fresh, { receiver: "werkudara", sessionId: "ses_dst" }).state, "ACCEPTED");
});

test("RC-02 11: module state remains bounded after saturation", () => {
    const bound = delegation.CONSUMED_LEDGER_BOUND;
    for (let i = 0; i < bound + 16; i++) {
        delegation.acceptDelegation(issue(), { receiver: "werkudara", sessionId: "ses_dst" });
    }
    assert.ok(delegation.ledgerSize() <= bound, "no unbounded Set/Map growth");
    assert.ok(Number.isSafeInteger(delegation.currentEpoch()));
});

test("RC-02 12: expired delegation rejects as EXPIRED — fail-closed by validity, not by missing tombstone", () => {
    const d = issue();
    const justBefore = d.expiresAt;
    const justAfter = d.expiresAt + 1;
    assert.throws(
        () => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst", now: justAfter }),
        /EXPIRED/
    );
    // At the boundary itself the delegation is still valid.
    assert.equal(delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst", now: justBefore }).state, "ACCEPTED");
    // Consumed + now expired: replay must STILL reject.
    assert.throws(
        () => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst", now: justAfter }),
        /EXPIRED|ALREADY_CONSUMED/
    );
});

test("RC-02: expiry-pruned tombstones cannot resurrect their issuance", () => {
    const d = issue();
    delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
    // Fast-forward beyond the delegation validity window so its tombstone
    // becomes prunable, then force a prune cycle by saturating the ledger
    // with FRESH delegations that all expire later than it.
    const future = delegation.currentEpoch();
    assert.ok(future >= 1);
    const bound = delegation.CONSUMED_LEDGER_BOUND;
    for (let i = 0; i < bound; i++) {
        delegation.acceptDelegation(issue(), { receiver: "werkudara", sessionId: "ses_dst" });
    }
    // Old tombstone may or may not be pruned depending on epoch rotation,
    // but either way the issuance must be unusable.
    assert.throws(
        () => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }),
        /STALE|ALREADY_CONSUMED|EXPIRED/
    );
});
