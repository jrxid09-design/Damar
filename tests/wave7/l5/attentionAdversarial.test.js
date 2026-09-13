const test = require("node:test");
const assert = require("node:assert");

const { createAttentionEconomy, BOUNDS } = require("../../../src/cognition/attention");

function manualClock(startMs) {
    let t = startMs;
    return { nowMs: () => t, advance: (ms) => { t += ms; } };
}

function assertThrowsReason(fn, reason) {
    assert.throws(fn, (err) => {
        assert.equal(err.reason, reason, `expected reason '${reason}', got '${err.reason}': ${err.message}`);
        return true;
    });
}

test("AT-A1: salience flooding from one sensor is rate-capped and the source marked noisy", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_SIGNALS_PER_SOURCE_PER_MINUTE: 3 } });
    for (let i = 0; i < 3; i++) {
        ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "sensor-1", subjectRef: { entityId: "e1" } }, "PERCEIVE");
    }
    assertThrowsReason(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "sensor-1", subjectRef: { entityId: "e1" } }, "PERCEIVE"),
        "SIGNAL_RATE_EXCEEDED");
    assert.equal(ae.isNoisySource("sensor-1"), true);
});

test("AT-repair-5: a hostile toJSON on subjectRef is never invoked while keying/deduping targets (independent audit AUD9-P2-2)", async () => {
    const ae = await createAttentionEconomy();
    let toJSONCalls = 0;
    const subjectRef = { entityId: "e1", toJSON() { toJSONCalls++; throw new Error("executed"); } };
    assert.doesNotThrow(() => ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef }, "PERCEIVE"));
    assert.equal(toJSONCalls, 0, "toJSON on caller-supplied subjectRef must never execute inside the cognition process");
});

test("AT-A2: corroboration counts distinct source+evidence pairs, not repeated messengers", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "ev-1" }, "PERCEIVE");
    for (let i = 0; i < 5; i++) {
        ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-1", subjectRef: { entityId: "e1" }, evidenceRef: "ev-1" }, "PERCEIVE");
    }
    const withRepeats = ae.getTarget(targetId).effectivePriority;

    const ae2 = await createAttentionEconomy();
    const { targetId: t2 } = ae2.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-A", subjectRef: { entityId: "e1" }, evidenceRef: "ev-A" }, "PERCEIVE");
    ae2.ingestSignal({ sourceKind: "SENSOR", sourceId: "adapter-B", subjectRef: { entityId: "e1" }, evidenceRef: "ev-B" }, "PERCEIVE");
    const withDistinct = ae2.getTarget(t2).effectivePriority;

    assert.ok(withDistinct > withRepeats, "sumber+bukti berbeda menaikkan prioritas lebih dari pesan berulang");
});

test("AT-repair-1: supporting signals per target are bounded across many distinct sources (Codex P1 round 9)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_SUPPORTING_SIGNALS_PER_TARGET: 3 } });
    let targetId;
    for (let i = 0; i < 10; i++) {
        ({ targetId } = ae.ingestSignal(
            { sourceKind: "SENSOR", sourceId: `adapter-${i}`, subjectRef: { entityId: "e1" }, evidenceRef: `ev-${i}` },
            "PERCEIVE"
        ));
    }
    assert.equal(ae.supportingSignalCount(targetId), 3,
        "dukungan per target tidak boleh tumbuh tanpa batas walau tiap sourceId berbeda");
});

test("AT-repair-2: total targets are bounded, not just queued ones (independent audit AUD-P1-3)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 2, MAX_TOTAL_TARGETS: 10 } });
    const ids = [];
    for (let i = 0; i < 50; i++) {
        ids.push(ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s", subjectRef: { entityId: "e" + i } }, "MAINTAIN").targetId);
    }
    const resident = ids.filter(id => ae.getTarget(id) !== null).length;
    assert.ok(resident <= 10, "target yang didemosi/selesai harus benar-benar dihapus setelah melewati MAX_TOTAL_TARGETS, bukan hanya diberi label DEFERRED selamanya");
});

test("AT-repair-3: tracked-source rate-limiting state is bounded across many distinct sources (independent audit AUD2-P2-2)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_TRACKED_SOURCES: 5 } });
    for (let i = 0; i < 50; i++) {
        ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s" + i, subjectRef: { entityId: "e" + i } }, "MAINTAIN");
    }
    assert.ok(ae.trackedSourceCount() <= 5, "signalsBySource tidak boleh tumbuh tanpa batas walau sourceId berbeda-beda");
});

test("AT-repair-4: the governor-mapping audit journal is bounded (independent audit AUD2-P2-2)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_GOVERNOR_MAPPING_AUDIT: 5 } });
    for (let i = 0; i < 50; i++) ae.toGovernorPriority("P3_GOAL");
    assert.ok(ae.governorMappingAudit().length <= 5, "governorMappingAudit tidak boleh tumbuh tanpa batas");
});

test("AT-A5-repair: a pick() blocked by full capacity never consumes the winning class's scheduling credit (Codex P2 round 5)", async () => {
    const clock = manualClock(0);
    let capacity = 0;
    const governorPort = { capacity: () => capacity };
    const ae = await createAttentionEconomy({ clock, governorPort });
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "owner-task" } }, "REASON");
    ae.ingestSignal({ sourceKind: "AGENT", sourceId: "agent-1", subjectRef: { entityId: "agent-task" } }, "REASON");

    // Kapasitas penuh: pick() harus null DAN tidak boleh diam-diam menguras
    // giliran kelas pemenang (P1_OWNER, kuota 35 > P4_BACKGROUND, kuota 10).
    assert.equal(ae.pick(), null);

    capacity = 1;
    const started = ae.pick();
    assert.ok(started, "harus ada target yang jalan begitu kapasitas terbuka");
    assert.equal(started.priorityClass, "P1_OWNER",
        "P1_OWNER tetap menang giliran pertama -- percobaan pick() yang diblokir kapasitas tidak boleh mengonsumsi kredit");
});

test("AT-A3: no signal field can set P0_SAFETY directly — only allowlisted origin can", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({
        sourceKind: "AGENT", sourceId: "attacker", subjectRef: { entityId: "e1" },
        proposedUrgency: 1, evidenceRef: { originKind: "SAFETY_MONITOR", priorityClass: "P0_SAFETY" }
        // note: an AGENT source can never reach P0 even if it forges the evidence shape.
    }, "REASON");
    assert.notEqual(ae.getTarget(targetId).priorityClass, "P0_SAFETY", "AGENT tidak pernah mencapai P0 walau evidence dipalsukan");
});

test("AT-A4: danger signal (high urgency) never maps to any authority scope", async () => {
    const ae = await createAttentionEconomy();
    const { targetId } = ae.ingestSignal({
        sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" }, proposedUrgency: 1
    }, "VERIFY");
    const target = ae.getTarget(targetId);
    assert.equal(Object.prototype.hasOwnProperty.call(target, "authorityScope"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(target, "grant"), false);
});

test("AT-A5: background flood cannot starve owner work — aging guarantee forces eventual scheduling", async () => {
    const clock = manualClock(0);
    const ae = await createAttentionEconomy({ clock, bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 5000 } });
    for (let i = 0; i < 500; i++) {
        ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: `bg-${i}`, subjectRef: { entityId: `bg${i}` } }, "MAINTAIN");
    }
    const { targetId: ownerTargetId } = ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "owner-work" } }, "REASON");
    clock.advance(BOUNDS.MAX_WAIT_MS + 1);
    const picked = ae.pick();
    assert.equal(picked.targetId, ownerTargetId, "jaminan aging memilih target yang sudah menunggu >= MAX_WAIT_MS");
});

test("AT-A6/AT-A7: MAX_PREEMPTIONS caps repeated preemption of the same target (livelock defense)", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_PREEMPTIONS: 1 } });
    const { targetId } = ae.ingestSignal({ sourceKind: "GOAL", sourceId: "g1", subjectRef: { entityId: "e1" } }, "PLAN");
    ae.pick();
    ae.preempt(targetId);
    assertThrowsReason(() => ae.preempt(targetId), "PREEMPTION_LIMIT_EXCEEDED");
});

test("AT-A8: silent discard is impossible — overflow journal accounts for every deferred target", async () => {
    const ae = await createAttentionEconomy({ bounds: { ...BOUNDS, MAX_QUEUED_TARGETS: 2 } });
    ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s1", subjectRef: { entityId: "e1" } }, "MAINTAIN");
    ae.ingestSignal({ sourceKind: "SYSTEM", sourceId: "s2", subjectRef: { entityId: "e2" } }, "MAINTAIN");
    ae.ingestSignal({ sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e3" } }, "REASON");
    assert.equal(ae.overflowCount(), 1);
    assert.equal(ae.overflowEntries().length, 1);
});

test("AT-A9: an uncorroborated agent urgency claim never jumps the queue above owner work", async () => {
    const ae = await createAttentionEconomy();
    const { targetId: agentTarget } = ae.ingestSignal({
        sourceKind: "AGENT", sourceId: "agent-1", subjectRef: { entityId: "e-agent" }, proposedUrgency: 1
    }, "REASON");
    const { targetId: ownerTarget } = ae.ingestSignal({
        sourceKind: "OWNER", sourceId: "owner-1", subjectRef: { entityId: "e-owner" }
    }, "REASON");
    assert.equal(ae.getTarget(agentTarget).priorityClass, "P4_BACKGROUND");
    assert.equal(ae.getTarget(ownerTarget).priorityClass, "P1_OWNER");
});

test("AT-A10: stale signal support decays, does not hold priority forever", async () => {
    const clock = manualClock(0);
    const ae = await createAttentionEconomy({ clock });
    const { targetId } = ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s1", subjectRef: { entityId: "e1" } }, "PERCEIVE");
    const fresh = ae.getTarget(targetId).effectivePriority;
    clock.advance(3_600_000); // 1 hour later, no new supporting signal
    ae.ingestSignal({ sourceKind: "SENSOR", sourceId: "s2", subjectRef: { entityId: "e-other" } }, "PERCEIVE"); // trigger a recompute pass
    const stale = ae.getTarget(targetId).effectivePriority;
    assert.ok(stale < fresh, "sinyal basi meluruh, tidak mempertahankan prioritas selamanya");
});
