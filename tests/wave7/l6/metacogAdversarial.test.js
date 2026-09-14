const test = require("node:test");
const assert = require("node:assert");

const { createMetacognition, BOUNDS } = require("../../../src/cognition/metacog");
const { computeConfidence } = require("../../../src/cognition/metacog/confidence");

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

function fakeLengthArray(items, badLen) {
    return new Proxy(items.slice(), {
        get(t, p, r) { return p === "length" ? badLen : Reflect.get(t, p, r); }
    });
}

test("MC-repair-41: openReview is rejected with OPEN_REVIEW_LIMIT_EXCEEDED (not silently retained past the cap) when MAX_TOTAL_REVIEWS_RETAINED is 0 -- a freshly-created review is always OPEN, and evictOldestClosedReviewIfOverBound only evicts CLOSED reviews, so it was retained regardless of the zero total cap (independent audit round 59, Codex, W7R59-P2-4)", async () => {
    const mc = await createMetacognition({ bounds: { MAX_TOTAL_REVIEWS_RETAINED: 0 } });
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" } }), "OPEN_REVIEW_LIMIT_EXCEEDED");
});

test("MC-repair-42: openReview honors a caller-sanctioned override of MAX_VALUE_NODES (including 0) -- buildSafeCognitiveCopy read the module's fixed VALUE_BOUNDS constant directly instead of the sanitized per-instance bounds, so a zero ceiling was silently ignored and one finding was still accepted (independent audit round 65, Codex, AUD65-P2-1, escalation of a round-64 disclosed-but-unfixed item)", async () => {
    const mc = await createMetacognition({ bounds: { MAX_VALUE_NODES: 0 } });
    assert.throws(() => mc.openReview({
        trigger: "CONTRADICTION", subjectRef: { entityId: "e1" },
        findings: [{ severity: 1 }], proposals: [], cost: { tokens: 0, ms: 0 }
    }));
});

test("MC-repair-4: explicit null findings/proposals is rejected as INVALID_RECORD, not an uncontrolled TypeError (independent audit AUD15-P2-3)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: null }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: null }), "INVALID_RECORD");
});

test("MC-repair-5: a null/undefined element inside findings/proposals, or a null cost, is rejected as INVALID_RECORD (independent audit AUD16-P2-1)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: [null] }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: [undefined] }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [null] }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, cost: null }), "INVALID_RECORD");
});

test("MC-repair-6: a BigInt/NaN/negative cost.tokens or cost.ms is rejected, never crashes or silently disables the reflection budget (independent audit AUD17-P2-1)", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, REFLECTION_BUDGET_TOKENS_PER_HOUR: 1000, REFLECTION_BUDGET_MS_PER_HOUR: 1000 } });
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, cost: { tokens: 10n, ms: 0 } }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, cost: { tokens: NaN, ms: 0 } }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, cost: { tokens: -1000, ms: 0 } }), "INVALID_RECORD");
    const r = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e2" }, cost: { tokens: 2000, ms: 0 } });
    assert.equal(r.state, "EXPIRED", "a valid over-budget cost must still be enforced");
});

test("MC-repair-8: assess() with a missing/null evidenceQuality fails safe to NO_EVIDENCE instead of an uncontrolled TypeError (independent audit AUD21-ADV-1)", async () => {
    const mc = await createMetacognition();
    const a1 = mc.assess({ entityId: "e1" }, "claim"); // evidenceQuality omitted entirely
    assert.equal(a1.basis, "NO_EVIDENCE");
    const a2 = mc.assess({ entityId: "e1" }, "claim", null);
    assert.equal(a2.basis, "NO_EVIDENCE");
});

test("MC-repair-10: a non-string trigger cannot bypass the TRIGGERS enum via toString-coercion inside the debounce key (independent audit AUD24-P2-2)", async () => {
    const mc = await createMetacognition();
    mc.openReview({ trigger: "CONTRADICTION", subjectRef: { entityId: "e1" } });
    let called = 0;
    const evil = { toString() { called++; return "CONTRADICTION"; } };
    assertThrowsReason(() => mc.openReview({ trigger: evil, subjectRef: { entityId: "e1" } }), "INVALID_RECORD");
    assert.equal(called, 0, "a non-string trigger's toString must never be invoked before the enum check");
});

test("MC-repair-9: openReview(null)/recordCalibration(null) are rejected as INVALID_RECORD, not a raw TypeError (independent audit AUD22-F-4)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview(null), "INVALID_RECORD");
    assertThrowsReason(() => mc.recordCalibration(null), "INVALID_RECORD");
});

test("MC-repair-11: hostile toString on proposal.kind/outcomeTier/reviewId never executes, and Symbol variants are rejected as domain errors, not raw TypeErrors (independent audit AUD25-P2-1)", async () => {
    const mc = await createMetacognition();
    // Bug review independen (audit putaran-38, AUD38-P2-2): sejak proposal
    // disaring SEKALI lewat buildSafeCognitiveCopy SEBELUM `kind` divalidasi
    // (menutup celah getter kind), method `toString` bersarang di dalam
    // evilKind sendiri kini ditolak lebih dulu sebagai materi executable
    // (EXECUTABLE_MATERIAL_REJECTED, bukan lagi INVALID_RECORD) -- toString
    // tetap TIDAK PERNAH dipanggil (dibaca lewat descriptor), invarian asli
    // tes ini tetap berlaku, hanya alasan penolakannya lebih ketat sekarang.
    let calledKind = 0;
    const evilKind = { toString() { calledKind++; return "APPLY_CHANGE"; } };
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: [{ kind: evilKind }] }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(calledKind, 0, "proposal.kind's toString must never be invoked before the enum check");

    let calledTier = 0;
    const evilTier = { toString() { calledTier++; return "T1"; } };
    assertThrowsReason(() => mc.recordCalibration({ outcomeTier: evilTier, outcomeRef: "r1" }), "INVALID_OUTCOME");
    assert.equal(calledTier, 0, "outcomeTier's toString must never be invoked before the enum check");
    assert.throws(() => mc.recordCalibration({ outcomeTier: Symbol("t"), outcomeRef: "r1" }), (err) => {
        assert.equal(err.reason, "INVALID_OUTCOME");
        return true;
    });

    let calledReviewId = 0;
    const evilReviewId = { toString() { calledReviewId++; return "nonexistent"; } };
    assertThrowsReason(() => mc.applyProposal(evilReviewId, 0), "UNKNOWN_REVIEW");
    assert.equal(calledReviewId, 0, "an unknown reviewId's toString must never be invoked while building the error message");
});

test("MC-repair-12: a Symbol evidenceQuality field fails safe to NO_EVIDENCE-shaped behavior, not a raw TypeError (independent audit AUD27-P2-6)", async () => {
    const mc = await createMetacognition();
    assert.doesNotThrow(() => mc.assess({ entityId: "e" }, "c", { sourceCount: Symbol("n") }));
    const a = mc.assess({ entityId: "e" }, "c", { sourceCount: Symbol("n") });
    assert.equal(a.basis, "NO_EVIDENCE");
});

test("MC-repair-13: a stateful getter evidenceQuality field (valid on first read, Symbol on later reads) never throws inside assess() (independent audit AUD28-P2-5)", async () => {
    const mc = await createMetacognition();
    let n = 0;
    const eq = {};
    Object.defineProperty(eq, "sourceCount", { enumerable: true, get() { n++; return n === 1 ? 3 : Symbol("boom"); } });
    assert.doesNotThrow(() => mc.assess({ entityId: "e" }, "c", eq));
});

test("MC-repair-14: a stateful getter subjectRef.entityId (valid on first read, Symbol on later reads) never throws inside openReview() (independent audit AUD28-P2-6)", async () => {
    const mc = await createMetacognition();
    let n = 0;
    const sr = {};
    Object.defineProperty(sr, "entityId", { enumerable: true, get() { n++; return n === 1 ? "e" : Symbol("boom"); } });
    assert.doesNotThrow(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: sr }));
});

test("MC-repair-15: computeConfidence reads each evidenceQuality field exactly once, so basis and value are always consistent even with a stateful getter (independent audit AUD29-P2-2)", async () => {
    const { computeConfidence } = require("../../../src/cognition/metacog/confidence");
    let n = 0;
    const eq = {};
    Object.defineProperty(eq, "verifiedCount", { enumerable: true, get() { n++; return n === 1 ? 5 : 0; } });
    Object.defineProperty(eq, "sourceCount", { enumerable: true, get() { return 0; } });
    const result = computeConfidence(eq, 0);
    assert.equal(result.basis, "VERIFIED_EVIDENCE");
    assert.ok(result.value > 0.8, `basis=VERIFIED_EVIDENCE must produce a matching high value, got ${result.value}`);
});

test("MC-repair-16: a stateful evidenceQuality.verifiedCount getter (5 then 0) never produces an assessment whose stored evidenceQuality contradicts its own basis/value (independent audit AUD30-P2-3)", async () => {
    const mc = await createMetacognition();
    let n = 0;
    const eq = { sourceCount: 0, contradictionCount: 0, freshestAtMs: null, inferenceOnly: false };
    Object.defineProperty(eq, "verifiedCount", { enumerable: true, get() { n++; return n === 1 ? 5 : 0; } });
    const a = mc.assess({ entityId: "e1" }, "claim", eq);
    if (a.basis === "VERIFIED_EVIDENCE") {
        assert.equal(a.evidenceQuality.verifiedCount, 5, "stored evidenceQuality must match the same snapshot that produced VERIFIED_EVIDENCE");
    } else {
        assert.equal(a.evidenceQuality.verifiedCount, 0);
    }
});

test("MC-repair-17: recordId is read exactly once in recordCalibration, so a stateful getter cannot double-count a calibration record via inconsistent reads (independent audit AUD30-P2-1)", async () => {
    const mc = await createMetacognition();
    mc.recordCalibration({ recordId: "C1", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: "o1", outcomeValue: 1, outcomeCorrect: true });

    let n = 0;
    const spec = { predictionRef: "p2", predictedValue: 1, predictedConfidence: 0.5, outcomeTier: "T1", outcomeRef: "o2", outcomeValue: 1, outcomeCorrect: true };
    Object.defineProperty(spec, "recordId", { enumerable: true, configurable: true, get() { n++; return "C1"; } });
    assertThrowsReason(() => mc.recordCalibration(spec), "DUPLICATE_RECORD_ID");
    assert.equal(n, 1, "recordId must be read exactly once");
});

test("MC-repair-19: a hostile getter nested inside a finding/proposal is never invoked by openReview() -- round-31's deep-freeze fix still read via `value[key]` (independent audit AUD32-P2-5)", async () => {
    const mc = await createMetacognition();
    let called = 0;
    const detail = {};
    Object.defineProperty(detail, "secret", { enumerable: true, configurable: true, get() { called++; return "boom"; } });
    // Sama seperti setiap sanitizer lane lain (buildSafeBeliefValue/
    // buildSafePayloadRef/walkSafe, lihat W7-ENV-14), properti accessor
    // ditolak TERTUTUP (throw), bukan dilewatkan diam-diam -- yang penting
    // untuk diverifikasi di sini adalah getter-nya TIDAK PERNAH terpanggil
    // sebelum ditolak.
    assertThrowsReason(() => mc.openReview({
        trigger: "SCHEDULED", subjectRef: { entityId: "e1" },
        findings: [{ severity: 1, detail }]
    }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(called, 0, "a nested caller getter must never be invoked while rejecting it");
});

test("MC-repair-20: assess()'s subjectRef and recordCalibration()'s stored refs/values are deep-frozen, not raw caller references (independent audit AUD32-ADV-1)", async () => {
    const mc = await createMetacognition();
    const nested = { deep: 1 };
    const a = mc.assess({ entityId: "e1", extra: nested }, "claim", { sourceCount: 0 });
    nested.deep = 999;
    assert.equal(a.subjectRef.extra.deep, 1, "mutating the caller's original nested object must not rewrite the stored assessment");
    assert.throws(() => { "use strict"; a.subjectRef.extra.deep = 2; });

    const ov = { x: 1 };
    const rec = mc.recordCalibration({ recordId: "C1", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: "o1", outcomeValue: ov, outcomeCorrect: true });
    ov.x = 999;
    assert.equal(rec.outcomeValue.x, 1, "mutating the caller's original outcomeValue must not rewrite the stored calibration record");
    assert.throws(() => { "use strict"; rec.outcomeValue.x = 2; });
});

test("MC-repair-21: buildSafeCognitiveCopy rejects BigInt and non-finite numbers, matching its sibling sanitizers, and openReview never raw-throws sorting hostile-severity findings past MAX_FINDINGS_PER_REVIEW (independent audit AUD33-P2-5)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.assess({ entityId: "e1", n: 10n }, "claim", { sourceCount: 0 }), "EXECUTABLE_MATERIAL_REJECTED");
    assertThrowsReason(() => mc.assess({ entityId: "e1", n: Infinity }, "claim", { sourceCount: 0 }), "EXECUTABLE_MATERIAL_REJECTED");

    const findings = [];
    for (let i = 0; i < BOUNDS.MAX_FINDINGS_PER_REVIEW + 1; i++) findings.push({ severity: 10n, detail: "x" });
    assertThrowsReason(() => mc.openReview({ trigger: "CONTRADICTION", subjectRef: { entityId: "e1" }, findings, proposals: [], cost: { tokens: 0, ms: 0 } }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("MC-repair-22: assess()'s claim is sanitized/bounded like subjectRef, not stored raw (independent audit AUD33-ADV-2)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.assess({ entityId: "e1" }, 10n, { sourceCount: 0 }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("MC-repair-23: cost.tokens/cost.ms are each read exactly once in openReview, so a stateful getter cannot pass the guard as 0 and then poison the reflection budget window on a later read (independent audit AUD34-ADV-2)", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, REFLECTION_BUDGET_TOKENS_PER_HOUR: 100 } });
    let n = 0;
    const cost = {};
    Object.defineProperty(cost, "tokens", { enumerable: true, configurable: true, get() { n++; return n <= 4 ? 0 : 1_000_000; } });
    cost.ms = 0;
    mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [], proposals: [], cost });
    assert.ok(n <= 1, "cost.tokens must be read exactly once");
    // A second, ordinary review must still fit under the (unpoisoned) budget.
    const r2 = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e2" }, findings: [], proposals: [], cost: { tokens: 10, ms: 0 } });
    assert.equal(r2.state, "OPEN", "the reflection budget window must not have been poisoned by a second, unread cost.tokens value");
});

test("MC-repair-25: openReview sanitizes each proposal via buildSafeCognitiveCopy before checking .kind, so an accessor kind is rejected closed without ever being invoked (independent audit AUD35-P2-2, tightened by AUD38-P2-2)", async () => {
    const mc = await createMetacognition();
    let n = 0;
    const p = {};
    Object.defineProperty(p, "kind", { enumerable: true, configurable: true, get() { n++; return "REPLAN"; } });
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [], proposals: [p], cost: { tokens: 0, ms: 0 } }), "EXECUTABLE_MATERIAL_REJECTED");
    assert.equal(n, 0, "buildSafeCognitiveCopy must reject the accessor via its property descriptor without ever invoking it");
});

test("MC-repair-27: openReview preserves the entityId-first short-circuit; a valid entityId subject's relationId accessor is never invoked (independent audit AUD37-P2-1)", async () => {
    const mc = await createMetacognition();
    let called = 0;
    const subjectRef = { entityId: "e1" };
    Object.defineProperty(subjectRef, "relationId", { enumerable: true, configurable: true, get() { called++; throw new Error("must not run"); } });
    const r = mc.openReview({ trigger: "SCHEDULED", subjectRef });
    assert.ok(r.reviewId);
    assert.equal(called, 0, "relationId must never be read when entityId already resolved the subjectKey");
});

test("MC-repair-28: recordCalibration's duplicate-recordId check is O(1) (Map-backed), not a linear array scan, and still correctly dedups/evicts (independent audit AUD37-ADV-1)", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, MAX_CALIBRATION_RECORDS: 3 } });
    for (let i = 0; i < 3; i++) {
        mc.recordCalibration({ recordId: `C${i}`, predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: `o${i}`, outcomeValue: 1, outcomeCorrect: true });
    }
    assertThrowsReason(() => mc.recordCalibration({ recordId: "C0", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: "o0b", outcomeValue: 1, outcomeCorrect: true }), "DUPLICATE_RECORD_ID");
    mc.recordCalibration({ recordId: "C3", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: "o3", outcomeValue: 1, outcomeCorrect: true });
    assert.equal(mc.calibrationCount(), 3, "retention must stay bounded at MAX_CALIBRATION_RECORDS");
    assert.doesNotThrow(() => mc.recordCalibration({ recordId: "C0", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9, outcomeTier: "T1", outcomeRef: "o0c", outcomeValue: 1, outcomeCorrect: true }), "C0 must have been evicted (FIFO) once retention overflowed, so its id is reusable");
});

test("MC-repair-31: buildSafeCognitiveCopy rejects a nested array whose .length is negative/NaN/Infinity/fractional instead of skipping or infinite-looping (independent audit W7R42-P2-1)", async () => {
    const mc = await createMetacognition();
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const nestedArr = fakeLengthArray([1], badLen);
        assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [{ severity: 1, extra: nestedArr }], proposals: [], cost: { tokens: 0, ms: 0 } }), "EXECUTABLE_MATERIAL_REJECTED");
    }
});

test("MC-repair-32: buildSafeArray inside openReview rejects a findings/proposals array whose .length is negative/NaN/Infinity/fractional (independent audit W7R42-P2-2)", async () => {
    const mc = await createMetacognition();
    for (const badLen of [-1, NaN, Infinity, 1.5]) {
        const findings = fakeLengthArray([{ severity: 1 }], badLen);
        assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings, proposals: [], cost: { tokens: 0, ms: 0 } }), "INVALID_RECORD");
    }
});

test("MC-repair-33: openReview/assess fail closed (not raw-throw) on a revoked-Proxy subjectRef/findings/finding-element (independent audit W7R43-P2-3/W7R43-P2-7)", async () => {
    const mc = await createMetacognition();
    const s = Proxy.revocable({ entityId: "e1" }, {});
    s.revoke();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: s.proxy, findings: [], proposals: [], cost: { tokens: 0, ms: 0 } }), "INVALID_RECORD");

    const f = Proxy.revocable([{ severity: 1 }], {});
    f.revoke();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: f.proxy, proposals: [], cost: { tokens: 0, ms: 0 } }), "INVALID_RECORD");

    const nested = Proxy.revocable({ a: 1 }, {});
    nested.revoke();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [{ severity: 1, extra: nested.proxy }], proposals: [], cost: { tokens: 0, ms: 0 } }), "EXECUTABLE_MATERIAL_REJECTED");

    const s2 = Proxy.revocable({ entityId: "e1" }, {});
    s2.revoke();
    assertThrowsReason(() => mc.assess(s2.proxy, "claim", { verifiedCount: 1, unverifiedCount: 0, contradictionCount: 0, freshnessMs: 0, sourceTier: "T1" }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("MC-repair-34: buildSafeCognitiveCopy's fail-closed catch itself does not raw-throw when the caught value is a hostile object whose own inspection throws (independent audit W7R44-P2-1)", async () => {
    const mc = await createMetacognition();
    const h = new Proxy({}, { getPrototypeOf() { throw new Error("RAW"); } });
    const hostile = new Proxy({}, {
        getOwnPropertyDescriptor() { throw h; },
        ownKeys() { return ["a"]; },
        getPrototypeOf() { return Object.prototype; }
    });
    assertThrowsReason(() => mc.assess(hostile, "claim", { verifiedCount: 1, unverifiedCount: 0, contradictionCount: 0, freshnessMs: 0, sourceTier: "T1" }), "EXECUTABLE_MATERIAL_REJECTED");
});

test("MC-repair-35: openReview/recordCalibration fail closed (not raw-throw) on a revoked-Proxy TOP-LEVEL spec argument or a revoked-Proxy cost (independent audit W7R44-P2-2)", async () => {
    const mc = await createMetacognition();
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    assertThrowsReason(() => mc.openReview(rev()), "INVALID_RECORD");
    assertThrowsReason(() => mc.recordCalibration(rev()), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: [], proposals: [], cost: rev() }), "INVALID_RECORD");
});

test("MC-repair-37: assess() never raw-throws on a revoked-Proxy evidenceQuality -- sanitizeEvidenceQuality falls back to NO_EVIDENCE-shaped safe defaults, matching its own established null/undefined contract (independent audit W7R45-P2-7)", async () => {
    const mc = await createMetacognition();
    const r = Proxy.revocable({}, {});
    r.revoke();
    let a;
    assert.doesNotThrow(() => { a = mc.assess({ entityId: "e1" }, "claim", r.proxy); }, "a revoked-Proxy evidenceQuality must not raw-throw out of assess()");
    assert.equal(a.basis, "NO_EVIDENCE", "a revoked evidenceQuality must fail safe to NO_EVIDENCE, same as null/undefined");
});

test("MC-repair-38: applyProposal rejects a non-integer proposalIndex (including a revoked Proxy, forced through ToPropertyKey as an array index) instead of raw-throwing (independent audit W7R46-P2-4)", async () => {
    const mc = await createMetacognition();
    const review = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: [{ kind: "PROBE" }] });
    const r = Proxy.revocable({}, {});
    r.revoke();
    assertThrowsReason(() => mc.applyProposal(review.reviewId, r.proxy, null), "INVALID_RECORD");
});

test("MC-repair-39: buildSafeArray never raw-throws on a Proxy findings/proposals array with a throwing length/index getter -- Array.isArray only proves identity, not trap-safety (independent audit AUD53-P2-1)", async () => {
    const mc = await createMetacognition();
    const arr = (trap) => new Proxy([1, 2, 3], { get(o, p, r) { if (p === trap) throw new Error("hostile"); return Reflect.get(o, p, r); } });
    assertThrowsReason(() => mc.openReview({ trigger: "LOW_CONFIDENCE_ACTION", subjectRef: { entityId: "e1" }, findings: arr("length") }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "CONTRADICTION", subjectRef: { entityId: "e2" }, proposals: arr("0") }), "INVALID_RECORD");
});

test("MC-repair-40: createMetacognition never raw-throws on a revoked/throwing clock or bounds -- normalized once at construction (independent audit AUD53-P2-2)", async () => {
    const rev = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    await assert.doesNotReject(() => createMetacognition({ clock: rev() }));
    await assert.doesNotReject(() => createMetacognition({ bounds: rev() }));
    const mc = await createMetacognition({ clock: { nowMs() { throw new Error("x"); } } });
    assert.doesNotThrow(() => mc.openReview({ trigger: "LOW_CONFIDENCE_ACTION", subjectRef: { entityId: "e1" } }));
});

test("MC-repair-36: buildSafeCognitiveCopy's object branch rejects a flat object whose key count exceeds MAX_VALUE_KEYS, matching every sibling sanitizer's key-count bound (independent audit W7R44-P2-4)", async () => {
    const mc = await createMetacognition();
    const big = {};
    for (let i = 0; i < BOUNDS.MAX_VALUE_KEYS + 1; i++) big["k" + i] = i;
    assertThrowsReason(() => mc.assess(big, "claim", { verifiedCount: 1, unverifiedCount: 0, contradictionCount: 0, freshnessMs: 0, sourceTier: "T1" }), "EXECUTABLE_MATERIAL_REJECTED");
    const ok = {};
    for (let i = 0; i < BOUNDS.MAX_VALUE_KEYS; i++) ok["k" + i] = i;
    assert.doesNotThrow(() => mc.assess(ok, "claim", { verifiedCount: 1, unverifiedCount: 0, contradictionCount: 0, freshnessMs: 0, sourceTier: "T1" }));
});

test("MC-repair-30: openReview's element validation never consults Symbol.iterator at all, so a findings array with a non-callable Symbol.iterator is still processed by plain index instead of raw-throwing (independent audit AUD40-ADV-1)", async () => {
    const mc = await createMetacognition();
    const a = [{ severity: 1 }];
    a[Symbol.iterator] = 42;
    let review;
    assert.doesNotThrow(() => { review = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: a, proposals: [], cost: { tokens: 0, ms: 0 } }); },
        "index-based iteration must never touch Symbol.iterator, so a non-callable one must not raw-throw");
    assert.equal(review.findings.length, 1, "the legitimate finding must still be validated and stored");
});

test("MC-repair-29: openReview rejects sparse (hole-bearing) findings/proposals arrays, not just explicit null/undefined elements (independent audit AUD39-P2-2)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: new Array(2), proposals: [], cost: { tokens: 0, ms: 0 } }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e2" }, findings: [], proposals: new Array(2), cost: { tokens: 0, ms: 0 } }), "INVALID_RECORD");
});

test("MC-repair-26: makeReview's cost guard and stored cost come from the same captured local, not independent reads (independent audit AUD35-ADV-3)", async () => {
    const { makeReview } = require("../../../src/cognition/metacog/records");
    let n = 0;
    const cost = {};
    Object.defineProperty(cost, "tokens", { enumerable: true, configurable: true, get() { n++; return n === 1 ? 5 : 999; } });
    cost.ms = 0;
    const review = makeReview({ reviewId: "R1", trigger: "SCHEDULED", findings: [], proposals: [], cost, bounds: BOUNDS });
    assert.equal(n, 1, "cost.tokens must be read exactly once");
    assert.equal(review.cost.tokens, 5, "the stored cost must be the same value that was validated");
});

test("MC-repair-24: recordCalibration's window (windowFrom/windowTo) is sanitized like predictionRef/outcomeValue, and outcomeRef is read exactly once (independent audit AUD34-ADV-3)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.recordCalibration({
        recordId: "C1", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9,
        outcomeTier: "T1", outcomeRef: "o1", outcomeValue: 1, outcomeCorrect: true,
        windowFrom: 10n, windowTo: "2020-01-01"
    }), "EXECUTABLE_MATERIAL_REJECTED");

    let n = 0;
    const spec = {
        recordId: "C2", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9,
        outcomeTier: "T1", outcomeValue: 1, outcomeCorrect: true
    };
    Object.defineProperty(spec, "outcomeRef", { enumerable: true, configurable: true, get() { n++; return "o2"; } });
    const rec = mc.recordCalibration(spec);
    assert.equal(n, 1, "outcomeRef must be read exactly once");
    assert.equal(rec.outcomeRef, "o2");
});

test("MC-repair-18: nested objects inside a stored finding/proposal are frozen too, not just the top level -- mutating the caller's original nested object after openReview() cannot rewrite the canonical review (independent audit AUD31-P2-5)", async () => {
    const mc = await createMetacognition();
    const detail = { x: 1 };
    const payload = { y: 1 };
    const review = mc.openReview({
        trigger: "SCHEDULED", subjectRef: { entityId: "e1" },
        findings: [{ severity: 1, detail }],
        proposals: [{ kind: "PROBE", payload }]
    });
    detail.x = 999;
    payload.y = 999;
    const stored = mc.getReview(review.reviewId);
    assert.equal(stored.findings[0].detail.x, 1, "mutating the caller's original nested object must not rewrite the stored finding");
    assert.equal(stored.proposals[0].payload.y, 1, "mutating the caller's original nested object must not rewrite the stored proposal");
    assert.throws(() => { "use strict"; stored.findings[0].detail.x = 2; });
});

test("MC-A1: fake confidence (model writes 0.99) is impossible — no API accepts a raw value", async () => {
    const mc = await createMetacognition();
    const a = mc.assess({ entityId: "e1" }, "claim", { value: 0.99, sourceCount: 0 }); // "value" in input ignored
    assert.notEqual(a.value, 0.99);
    assert.equal(a.basis, "NO_EVIDENCE");
});

test("MC-repair-2: a malformed subjectRef (neither entityId nor relationId) is rejected, not silently collapsed into another review's debounce key (independent audit AUD10-P2-3)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { kind: "alpha", id: "A" } }), "INVALID_RECORD");
    const r1 = mc.openReview({ trigger: "SCHEDULED", subjectRef: { relationId: "rA" } });
    const r2 = mc.openReview({ trigger: "SCHEDULED", subjectRef: { relationId: "rB" } });
    assert.notEqual(r1.reviewId, r2.reviewId, "two distinct relationId subjects must not collapse to the same debounced review");
});

test("MC-repair-3: replaying an already-used calibration recordId is rejected, not double-counted (independent audit AUD11-P2-8)", async () => {
    const mc = await createMetacognition();
    const spec = {
        recordId: "CAL-FIXED", predictionRef: "p", predictedValue: 1, predictedConfidence: 0.9,
        outcomeRef: "o", outcomeValue: 1, outcomeCorrect: true, outcomeTier: "T1", windowFrom: null, windowTo: null
    };
    mc.recordCalibration(spec);
    assertThrowsReason(() => mc.recordCalibration(spec), "DUPLICATE_RECORD_ID");
});

test("MC-repair-7: a BigInt or NaN predictedConfidence is rejected, not left to crash Brier scoring or poison the calibration score (independent audit AUD18-A1)", async () => {
    const mc = await createMetacognition();
    const base = { predictionRef: "p", predictedValue: 1, outcomeRef: "o", outcomeValue: 1, outcomeCorrect: true, outcomeTier: "T1", windowFrom: null, windowTo: null };
    assertThrowsReason(() => mc.recordCalibration({ ...base, predictedConfidence: 10n }), "INVALID_RECORD");
    assertThrowsReason(() => mc.recordCalibration({ ...base, predictedConfidence: NaN }), "INVALID_RECORD");
});

test("MC-repair-1: a hostile toJSON on subjectRef is never invoked while keying/debouncing reviews (independent audit AUD9-P2-2)", async () => {
    const mc = await createMetacognition();
    let toJSONCalls = 0;
    const subjectRef = { entityId: "e1", toJSON() { toJSONCalls++; throw new Error("executed"); } };
    assert.doesNotThrow(() => mc.openReview({ trigger: "SCHEDULED", subjectRef }));
    assert.equal(toJSONCalls, 0, "toJSON on caller-supplied subjectRef must never execute inside the cognition process");
});

test("MC-A2: applied-versus-proposed is verifiable — a rejected proposal is distinguishable from an applied one", async () => {
    const mc = await createMetacognition();
    const review = mc.openReview({
        trigger: "REPEATED_FAILURE", subjectRef: { entityId: "e1" },
        proposals: [{ kind: "LOWER_CONFIDENCE", ref: "b1" }]
    });
    const r = mc.applyProposal(review.reviewId, 0, () => { throw new Error("port refuses"); });
    const stored = mc.getReview(review.reviewId).proposals[0];
    assert.equal(r.applied, false);
    assert.equal(stored.rejected, true);
});

test("MC-A3: uncertainty cannot be suppressed — basis is always present, NO_EVIDENCE is never hidden", async () => {
    const mc = await createMetacognition();
    const a = mc.assess({ entityId: "e1" }, "claim", {});
    assert.equal(typeof a.basis, "string");
    assert.equal(a.basis, "NO_EVIDENCE");
});

test("MC-A4: reflection DoS via endless self-review is stopped by budget + open-review cap + debounce", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, REFLECTION_BUDGET_MS_PER_HOUR: 100, REVIEW_COOLDOWN_MS: 0 } });
    const r1 = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, cost: { tokens: 0, ms: 60 } });
    const r2 = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e2" }, cost: { tokens: 0, ms: 60 } });
    assert.equal(r1.state, "OPEN");
    assert.equal(r2.state, "EXPIRED", "anggaran refleksi habis -> review baru langsung EXPIRED, bukan reflect lebih lanjut");
});

test("MC-A4-repair: total retention of closed/expired reviews is bounded (Codex P1 round 3)", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, MAX_TOTAL_REVIEWS_RETAINED: 5, REFLECTION_BUDGET_MS_PER_HOUR: 0, REVIEW_COOLDOWN_MS: 0 } });
    for (let i = 0; i < 20; i++) {
        mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: `e${i}` }, cost: { tokens: 0, ms: 1 } });
    }
    // Every one of these is immediately EXPIRED (budget is 0) — retention must still be bounded,
    // even though openReviewCount() only counts OPEN reviews.
    assert.ok(mc.reviewCount() <= 5, `reviewCount ${mc.reviewCount()} melebihi MAX_TOTAL_REVIEWS_RETAINED`);
});

test("MC-A5: no authority call exists in this owner — module never imports src/authority", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(__dirname, "../../../src/cognition/metacog");
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".js")) continue;
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        assert.doesNotMatch(content, /require\(["'].*authority/, `${file} tidak boleh mengimpor authority`);
    }
});

test("MC-A6: calibration poisoning via forged outcomes is rejected — only T1/T2 with resolvable ref", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.recordCalibration({
        predictionRef: "p1", predictedValue: "x", predictedConfidence: 0.9,
        outcomeRef: "", outcomeValue: "x", outcomeCorrect: true, outcomeTier: "T2",
        windowFrom: "t0", windowTo: "t1"
    }), "INVALID_OUTCOME");
    assertThrowsReason(() => mc.recordCalibration({
        predictionRef: "p1", predictedValue: "x", predictedConfidence: 0.9,
        outcomeRef: "fact-1", outcomeValue: "x", outcomeCorrect: true, outcomeTier: "T7",
        windowFrom: "t0", windowTo: "t1"
    }), "INVALID_OUTCOME");
});

test("MC-A7: confidence laundering through repeated inference is capped, repetition adds no sources", async () => {
    const a1 = computeConfidence({ inferenceOnly: true, sourceCount: 0 }, 0);
    const a2 = computeConfidence({ inferenceOnly: true, sourceCount: 0 }, 0); // "repeated" call, same evidence shape
    assert.equal(a1.value, a2.value);
    assert.ok(a1.value <= 0.3, "INFERENCE_ONLY tetap rendah walau dipanggil berulang");
});

test("MC-A8: the interactive (owner-challenge) budget is separate — one trigger kind does not exhaust others", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, REVIEW_COOLDOWN_MS: 0 } });
    for (let i = 0; i < 5; i++) {
        mc.openReview({ trigger: "OWNER_CHALLENGE", subjectRef: { entityId: `e${i}` }, cost: { tokens: 100, ms: 10 } });
    }
    const scheduled = mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e-sched" }, cost: { tokens: 100, ms: 10 } });
    assert.equal(scheduled.state, "OPEN", "budget global belum habis, trigger lain tetap jalan");
});

test("MC-A9: urgency never lowers the confidence floor — assess() has no urgency parameter at all", async () => {
    const mc = await createMetacognition();
    const a = mc.assess({ entityId: "e1" }, "claim", { sourceCount: 1, freshestAtMs: 0 });
    assert.equal(Object.prototype.hasOwnProperty.call(a, "urgency"), false);
});

test("MC-A10: review cannot reopen a denied authority decision — no reviewId ever appears as an authority-decision reference", async () => {
    const mc = await createMetacognition();
    const review = mc.openReview({ trigger: "OWNER_CHALLENGE", subjectRef: { entityId: "e1" }, proposals: [{ kind: "ASK_OWNER", ref: "x" }] });
    assert.equal(mc.classifyProposal("ASK_OWNER"), "GOVERNED",
        "review hanya mengklasifikasi; membuka kembali keputusan otoritas adalah intent BARU di luar modul ini");
    void review;
});
