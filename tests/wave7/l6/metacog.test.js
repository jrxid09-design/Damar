const test = require("node:test");
const assert = require("node:assert");

const { createMetacognition, BOUNDS } = require("../../../src/cognition/metacog");

test("W7-L6 structural: createMetacognition exposes the frozen public contract", async () => {
    const mc = await createMetacognition();
    for (const method of ["assess", "openReview", "classifyProposal", "applyProposal", "recordCalibration", "getReview"]) {
        assert.equal(typeof mc[method], "function", `missing ${method}`);
    }
    assert.ok(mc.laws.METACOGNITION_NOT_SELF_AUTHORIZATION);
});

test("W7-L6 functional: assess() is deterministic and basis reflects evidence quality", async () => {
    const mc = await createMetacognition();
    const noEvidence = mc.assess({ entityId: "e1" }, "claim", {});
    assert.equal(noEvidence.basis, "NO_EVIDENCE");
    assert.ok(noEvidence.value <= BOUNDS.NO_EVIDENCE_CEILING);

    const verified = mc.assess({ entityId: "e1" }, "claim", { verifiedCount: 1, sourceCount: 1 });
    assert.equal(verified.basis, "VERIFIED_EVIDENCE");
    assert.ok(verified.value > noEvidence.value);
});

test("W7-L6 functional: cognitive-only proposals apply directly, governed ones only classify", async () => {
    const mc = await createMetacognition();
    const review = mc.openReview({
        trigger: "CONTRADICTION", subjectRef: { entityId: "e1" },
        findings: [{ kind: "contradiction", ref: "cs-1", severity: 3 }],
        proposals: [{ kind: "LOWER_CONFIDENCE", ref: "belief-1" }, { kind: "ABANDON_GOAL", ref: "goal-1" }]
    });

    let applied = null;
    const r1 = mc.applyProposal(review.reviewId, 0, (p) => { applied = p; });
    assert.equal(r1.classification, "COGNITIVE_ONLY");
    assert.equal(r1.applied, true);
    assert.equal(applied.kind, "LOWER_CONFIDENCE");

    const r2 = mc.applyProposal(review.reviewId, 1, () => { throw new Error("should never be called for GOVERNED"); });
    assert.equal(r2.classification, "GOVERNED");
    assert.equal(r2.applied, false);
});

test("W7-L6 functional: debounce increments a counter instead of opening a new review", async () => {
    const mc = await createMetacognition();
    const first = mc.openReview({ trigger: "CONTRADICTION", subjectRef: { entityId: "e1" } });
    const second = mc.openReview({ trigger: "CONTRADICTION", subjectRef: { entityId: "e1" } });
    assert.equal(first.reviewId, second.reviewId);
    assert.equal(second.debounceCount, 2);
});

test("W7-L6 boundedness: MAX_OPEN_REVIEWS enforced", async () => {
    const mc = await createMetacognition({ bounds: { ...BOUNDS, MAX_OPEN_REVIEWS: 2, REVIEW_COOLDOWN_MS: 0 } });
    mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e1" } });
    mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e2" } });
    assert.throws(() => mc.openReview({ trigger: "SCHEDULED", subjectRef: { entityId: "e3" } }),
        (err) => err.reason === "OPEN_REVIEW_LIMIT_EXCEEDED");
});

test("W7-L6 calibration: Brier score computed for a resolved T1 outcome", async () => {
    const mc = await createMetacognition();
    const rec = mc.recordCalibration({
        predictionRef: "pred-1", predictedValue: "on", predictedConfidence: 0.9,
        outcomeRef: "fact-1", outcomeValue: "on", outcomeCorrect: true, outcomeTier: "T1",
        windowFrom: "t0", windowTo: "t1"
    });
    assert.ok(rec.error < 0.02, "prediksi benar dengan confidence tinggi -> error Brier kecil");
});
