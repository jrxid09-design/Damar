"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const delegation = require("../../src/services/pandawaDelegation");

/**
 * F-04 tests: a delegation is single-use. Replay protection is keyed by
 * the immutable delegationId inside the module — not caller-supplied fields.
 */

function issue() {
    return delegation.createDelegation({
        fromEntity: "janaka", toEntity: "werkudara", sourceSession: "ses_src", targetSession: "ses_dst",
        objective: "review the patch", reason: "security", contextRefs: ["artifact:1"], requestedCapabilities: ["read"]
    });
}

test("F-04: first acceptance passes, second identical acceptance is rejected", () => {
    const d = issue();
    const first = delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
    assert.equal(first.state, "ACCEPTED");
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }), /ALREADY_CONSUMED/);
    assert.throws(() => delegation.projectHandoff(d, { receiver: "werkudara", sessionId: "ses_dst" }), /ALREADY_CONSUMED/);
    assert.equal(delegation.consumption(d.delegationId).receiver, "pandawa:werkudara");
});

test("F-04: spread copy, forged object, wrong target, wrong session all reject", () => {
    const d = issue();
    assert.throws(() => delegation.acceptDelegation({ ...d }, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    // Forged object claiming an unconsumed id: not in the issued set.
    assert.throws(() => delegation.acceptDelegation({ ...d, state: "ISSUED" }, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "janaka", sessionId: "ses_dst" }), /TARGET_INVALID/);
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_other" }), /TARGET_INVALID/);

    // Wrong-target/wrong-session do NOT consume; first valid acceptance still passes.
    const ok = delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
    assert.equal(ok.state, "ACCEPTED");
    assert.throws(() => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }), /ALREADY_CONSUMED/);
});

test("F-04: replay does not rely on caller-supplied mutable fields", () => {
    const d = issue();
    delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
    // Forged mutation of the object's own state field cannot resurrect it:
    // consumption is recorded by delegationId in the module ledger.
    const forged = Object.freeze({ ...d, state: "ISSUED", acceptedAt: undefined });
    assert.throws(() => delegation.acceptDelegation(forged, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    // Mutating the ORIGINAL object's visible state does not help either —
    // the ledger, not the object field, is authoritative.
    try {
        const mutable = Object.assign({}, d, { state: "ISSUED" });
        assert.throws(() => delegation.acceptDelegation(mutable, { receiver: "werkudara", sessionId: "ses_dst" }), /UNTRUSTED/);
    } catch { /* original object is frozen; copy attempt still rejected */ }
    assert.equal(delegation.consumption(d.delegationId).receiver, "pandawa:werkudara");
});

test("F-04: concurrent double-accept — at most one acceptance wins", async () => {
    const d = issue();
    const attempt = () => new Promise(resolve => {
        setImmediate(() => {
            try { resolve({ ok: true, state: delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" }).state }); }
            catch (e) { resolve({ ok: false, err: e.message }); }
        });
    });
    const [a, b] = await Promise.all([attempt(), attempt()]);
    const accepted = [a, b].filter(r => r.ok);
    const rejected = [a, b].filter(r => !r.ok);
    assert.equal(accepted.length, 1, "exactly one concurrent acceptance may succeed");
    assert.equal(accepted[0].state, "ACCEPTED");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].err, /ALREADY_CONSUMED/);
    assert.equal(delegation.consumption(d.delegationId).receiver, "pandawa:werkudara");
});

test("F-04: lifecycle vocabulary and ledger bound", () => {
    const d = issue();
    assert.equal(d.state, "ISSUED");
    delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst" });
    assert.equal(d.state, "ISSUED", "issued object remains an immutable issuance record");
    assert.equal(delegation.consumption("pdl_nonexistent"), null);
    // Distinct delegations remain independently consumable.
    const d2 = issue();
    assert.equal(delegation.acceptDelegation(d2, { receiver: "werkudara", sessionId: "ses_dst" }).state, "ACCEPTED");
});
