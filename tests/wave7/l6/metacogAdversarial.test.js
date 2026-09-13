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

test("MC-repair-4: explicit null findings/proposals is rejected as INVALID_RECORD, not an uncontrolled TypeError (independent audit AUD15-P2-3)", async () => {
    const mc = await createMetacognition();
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, findings: null }), "INVALID_RECORD");
    assertThrowsReason(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" }, proposals: null }), "INVALID_RECORD");
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
