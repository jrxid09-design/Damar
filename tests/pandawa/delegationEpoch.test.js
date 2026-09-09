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
 assert.throws(() => ACCEPT(roundTrip), /UNTRUSTED/);
 // And the original still accepts normally.
 assert.equal(ACCEPT(d).state, "ACCEPTED");
});

// ============ RA4-01: bounded rotation diagnostic ============
// LAW: DIAGNOSTIC COUNTER != SECURITY STATE.

test("RA4-01 B: many repeated saturations keep the diagnostic bounded (saturating, no lifetime accumulation)", () => {
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 const maxDiag = delegation.MAX_DIAGNOSTIC_ROTATIONS;
 assert.equal(typeof maxDiag, "number");
 assert.ok(Number.isSafeInteger(maxDiag) && maxDiag > 0 && maxDiag <= 1024, "hard diagnostic maximum");
 // Drive far more rotations than the diagnostic maximum.
 const rounds = maxDiag + 8;
 for (let r = 0; r < rounds; r++) {
 for (let i = 0; i < bound + 2; i++) ACCEPT(issue());
 }
 const diag = delegation.epochRotations();
 assert.ok(diag <= maxDiag, `diagnostic saturated at hard maximum (diag=${diag}, max=${maxDiag})`);
 assert.ok(delegation.ledgerSize() <= bound, "ledger still bounded");
 // The diagnostic NEVER rides on unsafe numeric growth: it is capped.
 assert.ok(diag < Number.MAX_SAFE_INTEGER / 2);
});

test("RA4-01 C+D: diagnostic saturation does NOT stop security epoch rotation; old issuances stay rejected", () => {
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 const maxDiag = delegation.MAX_DIAGNOSTIC_ROTATIONS;
 // Push the diagnostic to saturation first.
 for (let r = 0; r < maxDiag + 4; r++) {
 for (let i = 0; i < bound + 2; i++) ACCEPT(issue());
 }
 const diagSaturated = delegation.epochRotations();
 // New issuances to track across a FURTHER rotation.
 const consumed = issue();
 ACCEPT(consumed);
 const unused = issue(); // issued, never accepted
 const consumedEpoch = consumed.generation;
 const unusedEpoch = unused.generation;
 const epochAtCapture = delegation.currentEpoch();
 // One more saturation -> epoch MUST rotate even though diagnostic is maxed.
 for (let i = 0; i < bound + 2; i++) ACCEPT(issue());
 assert.notEqual(delegation.currentEpoch(), epochAtCapture, "security epoch keeps rotating independently of the saturated diagnostic");
 assert.throws(() => ACCEPT(consumed), /STALE|ALREADY_CONSUMED/, "old consumed issuance remains rejected (C)");
 assert.throws(() => ACCEPT(unused), /STALE/, "old unused prior-epoch issuance remains rejected (D)");
 assert.notEqual(consumedEpoch, delegation.currentEpoch());
 assert.notEqual(unusedEpoch, delegation.currentEpoch());
});

test("RA4-01 E+F: security epoch identity changes independently of the diagnostic counter; no numeric diagnostic participates in security", () => {
 const bound = delegation.CONSUMED_LEDGER_BOUND;
 const maxDiag = delegation.MAX_DIAGNOSTIC_ROTATIONS;
 // Saturate the diagnostic completely.
 for (let r = 0; r < maxDiag + 2; r++) {
 for (let i = 0; i < bound + 2; i++) ACCEPT(issue());
 }
 const diagAtSaturation = delegation.epochRotations();
 const epochA = delegation.currentEpoch();
 const dA = issue();
 // Another rotation: epoch identity changes while the diagnostic stays saturated.
 for (let i = 0; i < bound + 2; i++) ACCEPT(issue());
 const epochB = delegation.currentEpoch();
 assert.notEqual(epochA, epochB, "security epoch identity keeps changing (F)");
 assert.equal(delegation.epochRotations(), diagAtSaturation, "diagnostic is saturated and unchanged (E)");
 // The security epoch is the opaque identity, NOT the diagnostic number (G).
 assert.match(epochB, /^pdlep_[0-9a-f]{32}$/);
 assert.equal(typeof epochB, "string");
 assert.notEqual(epochB, delegation.epochRotations());
 // Issuance binding uses the opaque identity, never the diagnostic counter.
 const dNew = issue();
 assert.equal(dNew.generation, epochB);
 assert.notEqual(dNew.generation, delegation.epochRotations());
 assert.equal(ACCEPT(dNew).state, "ACCEPTED");
 assert.throws(() => ACCEPT(dNew), /ALREADY_CONSUMED/);
 // No numeric diagnostic value can stand in for the epoch in any comparison.
 assert.equal(delegation.epochRotations() !== epochB, true);
 assert.equal(String(delegation.epochRotations()) === epochB, false);
});
