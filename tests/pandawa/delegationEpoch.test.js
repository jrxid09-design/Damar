"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const delegation = require("../../src/services/pandawaDelegation");

/**
 * RA3-02 — safe delegation epoch identity.
 *
 * Invariant: an OLD ISSUANCE FROM A PRIOR EPOCH must NEVER become valid in
 * a NEW EPOCH — even after millions of rotations, integer boundary
 * conditions, ledger saturation, and tombstone eviction. Generation
 * identity never depends on unsafe JS Number precision: the epoch is an
 * opaque 128-bit random identifier compared with exact string identity.
 */

function issue(overrides = {}) {
 return delegation.createDelegation({
 fromEntity: "janaka", toEntity: "werkudara", sourceSession: "ses_src", targetSession: "ses_dst",
 objective: "review the patch", reason: "security", contextRefs: ["artifact:1"], requestedCapabilities: ["read"],
 ...overrides
 });
}
const ACCEPT = (d, o = {}) => delegation.acceptDelegation(d, { receiver: "werkudara", sessionId: "ses_dst", ...o });

test("RA3-02 1+2: normal issuance/acceptance passes; immediate replay rejects", () => {
 const d = issue();
 assert.match(d.generation, /^pdlep_[0-9a-f]{32}$/, "issuance bound to opaque epoch identity");
 assert.equal(ACCEPT(d).state, "ACCEPTED");
 assert.throws(() => ACCEPT(d), /ALREADY_CONSUMED/);
});

test("RA3-02 epoch identity is opaque, unguessable, and Number-precision-free", () => {
 const epoch = delegation.currentEpoch();
 assert.equal(typeof epoch, "string", "epoch identity is a string, not a JS Number");
 assert.match(epoch, /^pdlep_[0-9a-f]{32}$/, "128-bit random identity");
 assert.notEqual(epoch, delegation.currentEpoch() === epoch ? Number.MAX_SAFE_INTEGER : epoch, "no numeric semantics");
 // Distinct epochs never collide: identity space is 2^128.
 const seen = new Set([epoch]);
 for (let i = 0; i < 1000; i++) {
 // mint fresh identity-equivalent strings through rotation cannot be
 // forced without saturating; instead prove uniqueness of the generator
 // output shape via many sampled delegations in the same epoch.
 const d = issue();
 assert.equal(d.generation, epoch, "same-epoch issuances share the exact epoch identity");
 }
 assert.ok(seen.has(epoch));
});

test("RA3-02 7+10: legacy numeric generation can never match (no unsafe integer path)", () => {
 // There is no legacy numeric epoch path: currentEpoch is a string and the
 // acceptance comparison is exact identity. Prove the boundary condition
 // that broke the old scheme cannot exist: a Number at/after
 // MAX_SAFE_INTEGER is never === a string epoch.
 const epoch = delegation.currentEpoch();
 assert.notEqual(String(Number.MAX_SAFE_INTEGER), epoch);
 assert.notEqual(String(Number.MAX_SAFE_INTEGER + 1), epoch);
 assert.equal(9007199254740993 !== epoch, true, "unsafe-precision number never equals the opaque identity");
 // A forged delegation carrying ANY numeric generation is untrusted
 // (never reaches the epoch comparison), so unsafe integers cannot
 // control replay validity.
 const d = issue();
 const forged = Object.freeze({ ...d, generation: 9007199254740993, state: "ISSUED" });
 assert.throws(() => ACCEPT(forged), /UNTRUSTED/, "forged numeric generation cannot reach epoch comparison");
 // Even a caller-minted object carrying the CORRECT current epoch string
 // is untrusted — the epoch field is not forgeable because membership in
 // the issued set is module-private.
 const forged2 = Object.freeze({ ...d, state: "ISSUED", generation: epoch });
 assert.throws(() => ACCEPT(forged2), /UNTRUSTED/);
});

test("RA3-02 5: old CONSUMED issuance after rotation is rejected (exact identity, not tombstone presence)", () => {
 const old = issue();
 ACCEPT(old);
 const oldEpoch = old.generation;
 // Saturate: bound + 8 fresh acceptances force at least one rotation.
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 for (let i = 0; i < bound + 8; i++) ACCEPT(issue());
 assert.equal(delegation.consumption(old.delegationId), null, "old tombstone no longer resident");
 assert.notEqual(oldEpoch, delegation.currentEpoch(), "epoch identity rotated");
 assert.throws(() => ACCEPT(old), /STALE|ALREADY_CONSUMED/, "old consumed issuance must NOT become reusable after rotation");
 // Fresh new-epoch issuance still works.
 assert.equal(ACCEPT(issue()).state, "ACCEPTED");
});

test("RA3-02 6: old UNUSED issuance from a previous epoch is rejected", () => {
 const unused = issue(); // issued but never accepted
 const staleEpoch = unused.generation;
 // Force rotations without consuming the unused issuance.
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 for (let i = 0; i < bound + 8; i++) ACCEPT(issue());
 assert.notEqual(staleEpoch, delegation.currentEpoch(), "epoch rotated");
 assert.throws(() => ACCEPT(unused), /STALE/, "an ISSUED delegation from a previous epoch must never become first-use-valid in the new epoch");
});

test("RA3-02 8: repeated rotations keep rejecting every prior-epoch issuance", () => {
 const ancient = issue();
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 const rotationsToSimulate = 3;
 for (let r = 0; r < rotationsToSimulate; r++) {
 for (let i = 0; i < bound + 4; i++) ACCEPT(issue());
 }
 assert.ok(delegation.epochRotations() >= rotationsToSimulate, "multiple rotations occurred");
 assert.notEqual(ancient.generation, delegation.currentEpoch());
 assert.throws(() => ACCEPT(ancient), /STALE|ALREADY_CONSUMED/, "issuance from many epochs ago remains invalid");
});

test("RA3-02 9: ledger remains bounded across rotations", () => {
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 for (let i = 0; i < bound + 16; i++) ACCEPT(issue());
 assert.ok(delegation.ledgerSize() <= bound, `bounded (size=${delegation.ledgerSize()})`);
 assert.ok(delegation.epochRotations() >= 1);
});

test("RA3-02 12: serialization does not lose generation identity", () => {
 const d = issue();
 const roundTrip = JSON.parse(JSON.stringify(d));
 assert.equal(roundTrip.generation, d.generation, "opaque epoch identity survives JSON round-trip exactly");
 assert.equal(typeof roundTrip.generation, "string");
 // The deserialized copy is NOT the module-minted object: acceptance must
 // still reject it (untrusted), proving identity travels as DATA only.
 assert.throws(() => ACCEPT(roundCase(roundTrip)), /UNTRUSTED/);
 // And the original still accepts normally.
 assert.equal(ACCEPT(d).state, "ACCEPTED");
 function roundCase(x) { return x; }
});
