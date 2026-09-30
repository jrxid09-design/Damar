"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryAccStore } = require("../../../src/cognition/persistence/AccStore");
const { makeAutobiographicalIdentity } = require("../../../src/cognition/autobiography/index");

const IDENTITY_ID = "damar-test-identity";

function makeOps() {
    return makeAutobiographicalIdentity(createMemoryAccStore());
}

function baseOpts(id) {
    return { episodeId: id, damarIdentityId: IDENTITY_ID, title: "Test", narrative: "Test episode." };
}

test("RT-W10-21: fake episode with no evidence is UNSUPPORTED and inert", async () => {
    const ops = makeOps();
    const episode = ops.makeEpisode(baseOpts("ep-21"));
    assert.equal(episode.verificationState, "UNSUPPORTED");
    assert.equal(ops.canCiteAsReason(episode), false);
});

test("RT-W10-22: episode rewrite refused, correction appended to original", async () => {
    const ops = makeOps();
    await ops.formation.formEpisode(baseOpts("ep-22"));
    const updated = await ops.correction.applyCorrection("ep-22", { reason: "wrong date", byKind: "OWNER", correctionRef: "ref-1" });
    assert.equal(updated.narrative, "Test episode.", "original narrative unchanged");
    assert.ok(updated.corrections.length >= 1, "correction appended");
    assert.equal(updated.corrections[0].reason, "wrong date");
});

test("RT-W10-23: episode cites itself as evidence — refused", () => {
    const ops = makeOps();
    assert.throws(
        () => ops.makeEpisode({ ...baseOpts("ep-23"), evidence: ["ep-23"] }),
        /may not cite itself|self.*evidence/i
    );
});

test("RT-W10-24: episode verificationState reflects evidence resolution", async () => {
    const ops = makeOps();
    const episode = ops.makeEpisode({ ...baseOpts("ep-24"), evidence: ["ledger-ref-A", "ledger-ref-B"] });
    const state = ops.computeVerificationState(episode, ref => ref === "ledger-ref-A");
    assert.equal(state, "PARTIALLY_SUPPORTED");
    const stateAll = ops.computeVerificationState(episode, () => true);
    assert.equal(stateAll, "SUPPORTED");
});

test("RT-W10-25: episode flood is rate-capped", async () => {
    const ops = makeOps();
    const { BOUNDS } = ops;
    for (let i = 0; i < BOUNDS.MAX_EPISODES_PER_HOUR; i++) {
        await ops.formation.formEpisode({ episodeId: `ep-25-${i}`, damarIdentityId: IDENTITY_ID, title: "T", narrative: "N" });
    }
    const overflow = await ops.formation.formEpisode(baseOpts("ep-25-overflow"));
    assert.equal(overflow.coalesced, true);
    assert.equal(overflow.reason, "rate_cap");
});

test("RT-W10-26: secrets in narrative are redacted on formation", async () => {
    const ops = makeOps();
    const result = await ops.formation.formEpisode({
        episodeId: "ep-26",
        damarIdentityId: IDENTITY_ID,
        title: "T",
        narrative: "User provided password=hunter2 during session.",
    });
    assert.ok(result.narrative.includes("[REDACTED]"), "secret must be redacted");
    assert.equal(result.secretsRedacted, true);
});

test("RT-W10-27: disputed episode cannot be cited as reason to act", () => {
    const ops = makeOps();
    const episode = ops.makeEpisode(baseOpts("ep-27"));
    episode.verificationState = "DISPUTED";
    assert.equal(ops.canCiteAsReason(episode), false);
});

test("RT-W10-28: compaction must not raise verificationState", () => {
    const ops = makeOps();
    assert.doesNotThrow(() => ops.assertCompactionDoesNotRaise("SUPPORTED", "SUPPORTED"));
    assert.doesNotThrow(() => ops.assertCompactionDoesNotRaise("SUPPORTED", "PARTIALLY_SUPPORTED"));
    assert.throws(
        () => ops.assertCompactionDoesNotRaise("UNSUPPORTED", "SUPPORTED"),
        /compaction may not raise|never raises/i
    );
    // Invariant 14: must also throw for unrecognized state strings
    assert.throws(
        () => ops.assertCompactionDoesNotRaise("BOGUS_STATE", "SUPPORTED"),
        /unknown verificationState/i
    );
    assert.throws(
        () => ops.assertCompactionDoesNotRaise("SUPPORTED", "BOGUS_STATE"),
        /unknown verificationState/i
    );
});

test("RT-W10-29: redaction preserves marker and request record", async () => {
    const ops = makeOps();
    await ops.formation.formEpisode(baseOpts("ep-29"));
    const requestRecord = { requestId: "req-1", requestedBy: "owner", requestedAt: Date.now() };
    const redacted = await ops.correction.redactEpisode("ep-29", requestRecord);
    assert.equal(redacted.narrative, "[REDACTED]");
    assert.equal(redacted.redacted, true);
    assert.ok(redacted.redactionRequest, "redaction request record must be retained");
    assert.equal(redacted.redactionRequest.requestId, "req-1");
});

test("RT-W10-30: episodes are bound to damarIdentityId — transplant detectable", () => {
    const ops = makeOps();
    const episodeA = ops.makeEpisode({ episodeId: "ep-30", damarIdentityId: "identity-A", title: "T", narrative: "N" });
    assert.equal(episodeA.damarIdentityId, "identity-A", "identity binding is fixed at creation");
    const episodeB = ops.makeEpisode({ episodeId: "ep-30b", damarIdentityId: "identity-B", title: "T", narrative: "N" });
    assert.notEqual(episodeB.damarIdentityId, episodeA.damarIdentityId);
});
