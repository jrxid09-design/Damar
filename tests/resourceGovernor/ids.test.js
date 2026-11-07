"use strict";

const test = require("node:test");
const { assert, governorFactory } = require("./helpers");
const { createWorkloadId, workloadIdToString, canonicalizeWorkloadId, newWorkloadId } = governorFactory.ids;

test("workload id: accepts canonical lowercase kebab form", () => {
    const id = createWorkloadId("re-analysis-job-7");
    assert.equal(id.value, "re-analysis-job-7");
    assert.equal(id.kind, "WorkloadId");
});

test("workload id: rejects whitespace padding (no trim normalization)", () => {
    for (const raw of [" job", "job ", "jo b", "job\n", "job\t", "job\u00a0"]) {
        assert.throws(() => createWorkloadId(raw), /INVALID_WORKLOAD_ID/, `should reject ${JSON.stringify(raw)}`);
    }
});

test("workload id: case tricks cannot collide — uppercase is rejected, not folded", () => {
    assert.throws(() => createWorkloadId("Job-1"), /INVALID_WORKLOAD_ID/);
    assert.throws(() => createWorkloadId("JOB-1"), /INVALID_WORKLOAD_ID/);
});

test("workload id: separator tricks rejected (empty segments, leading/trailing dash)", () => {
    for (const raw of ["-job", "job-", "jo--b", "---"]) {
        assert.throws(() => createWorkloadId(raw), /INVALID_WORKLOAD_ID/);
    }
});

test("workload id: non-strings and out-of-range lengths fail closed", () => {
    assert.throws(() => createWorkloadId(null), TypeError);
    assert.throws(() => createWorkloadId(42), TypeError);
    assert.throws(() => createWorkloadId("ab"), /length/);
    assert.throws(() => createWorkloadId("a".repeat(65)), /length|grammar/);
});

test("workload id: canonicalization is deterministic and frozen", () => {
    const a = createWorkloadId("stable-id");
    const b = createWorkloadId("stable-id");
    assert.equal(canonicalizeWorkloadId("stable-id"), "stable-id");
    assert.ok(a.equals(b));
    assert.equal(a.equals(createWorkloadId("other-id")), false);
    assert.throws(() => { a.value = "tampered"; }, TypeError);
});

test("workload id: toString round-trips through workloadIdToString", () => {
    const id = createWorkloadId("voice-session-1");
    assert.equal(workloadIdToString(id), "voice-session-1");
});

test("workload id: workloadIdToString rejects forged plain objects", () => {
    assert.throws(() => workloadIdToString({ kind: "WorkloadId", value: "voice-session-1" }), /INVALID_WORKLOAD_ID/);
    assert.throws(() => workloadIdToString({ kind: "WorkloadId", value: "Has Space" }), /INVALID_WORKLOAD_ID/);
});

test("workload id: branded forged objects fail length bounds at trust boundary", () => {
    const genuine = createWorkloadId("trust-boundary");
    const brand = Object.getOwnPropertySymbols(genuine)[0];
    const forge = (value) => Object.freeze({
        [brand]: true, kind: "WorkloadId", value,
        toString() { return value; }, equals() { return true; }
    });
    assert.throws(() => workloadIdToString(forge("x")), /length|grammar/);
    assert.throws(() => workloadIdToString(forge("ab")), /length/);
    assert.throws(() => workloadIdToString(forge("a".repeat(65))), /length/);
    assert.throws(() => workloadIdToString(forge("UPPER-CASE")), /grammar/);
    assert.equal(workloadIdToString(forge("still-valid-id")), "still-valid-id",
        "well-formed branded value remains usable");
});

test("workload id: canonicalizeWorkloadId and workloadIdToString enforce identical bounds", () => {
    const genuine = createWorkloadId("mirror-check");
    const brand = Object.getOwnPropertySymbols(genuine)[0];
    for (const bad of ["x", "a".repeat(65), "", "Bad Name"]) {
        assert.throws(() => canonicalizeWorkloadId(bad), Error);
        assert.throws(() => workloadIdToString(Object.freeze({
            [brand]: true, kind: "WorkloadId", value: bad
        })), Error);
    }
});

test("workload id: generated ids are valid and length-bounded", () => {
    const gen = newWorkloadId("x".repeat(70), { seq: 123456789, entropy: "AB-CD!ef" });
    assert.match(gen.value, /^[a-z0-9-]+$/);
    assert.ok(gen.value.length <= 64);
    assert.doesNotThrow(() => canonicalizeWorkloadId(gen.value));
});
