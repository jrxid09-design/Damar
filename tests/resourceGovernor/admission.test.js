"use strict";

const test = require("node:test");
const {
    assert, manualClock, FakeObserver, ThrowingObserver,
    makeGovernor, BASE_CONFIG, demand
} = require("./helpers");
const { createWorkloadId } = require("../../src/runtime/resourceGovernor/ids");
const { ADMISSION_OUTCOMES: OUT, REASONS, PRESSURE_BANDS } = require("../../src/runtime/resourceGovernor/model");

test("admission: healthy host admits an AGENT workload with authentic lease", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const d = gov.admit(createWorkloadId("agent-1"), demand());
    assert.equal(d.outcome, OUT.ADMIT);
    assert.equal(d.reason, REASONS.OK_ADMITTED);
    assert.equal(d.lease.workloadId, "agent-1");
    assert.equal(d.lease.kind, "ResourceLease");
});

test("admission: global limit enforced — excess queued deterministically", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, globalConcurrencyLimit: 12, groupLimits: { default: 12 }, maxQueue: 8 }
    });
    for (let i = 1; i <= 12; i++) {
        assert.equal(gov.admit(createWorkloadId(`w-${i}`), demand()).outcome, OUT.ADMIT);
    }
    const thirteenth = gov.admit(createWorkloadId("w-13"), demand());
    assert.equal(thirteenth.outcome, OUT.QUEUE);
    assert.equal(thirteenth.reason, REASONS.OK_QUEUED);
    assert.equal(gov.getResourceStatus().activeLeases, 12);
});

test("admission: group limit enforced independently of global headroom", () => {
    const gov = makeGovernor({
        config: {
            globalConcurrencyLimit: 10,
            groupLimits: { "llm-heavy": 1, default: 10 },
            maxQueue: 8
        }
    });
    const first = gov.admit(createWorkloadId("llm-a"), demand({ concurrencyGroup: "llm-heavy" }));
    assert.equal(first.outcome, OUT.ADMIT);
    const second = gov.admit(createWorkloadId("llm-b"), demand({ concurrencyGroup: "llm-heavy" }));
    assert.equal(second.outcome, OUT.QUEUE);
    assert.equal(second.reason, REASONS.OK_QUEUED);
});

test("admission: class-specific limit enforced", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, classConcurrencyLimits: { TEST: 1 }, maxQueue: 8 }
    });
    assert.equal(gov.admit(createWorkloadId("t-1"), demand({ workloadClass: "TEST" })).outcome, OUT.ADMIT);
    const second = gov.admit(createWorkloadId("t-2"), demand({ workloadClass: "TEST" }));
    assert.equal(second.outcome, OUT.QUEUE);
    assert.equal(gov.getResourceStatus().queueDepth >= 1, true);
});

test("admission: unknown concurrency group fails closed", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    const d = gov.admit(createWorkloadId("escape-1"), demand({ concurrencyGroup: "sneaky-new-group" }));
    assert.equal(d.outcome, OUT.REJECT_RESOURCE_LIMIT);
    assert.equal(d.reason, REASONS.UNKNOWN_GROUP);
});

test("admission: malformed workload id and demand fail closed without state change", () => {
    const gov = makeGovernor({ config: BASE_CONFIG });
    assert.equal(gov.admit("not-an-id-object", demand()).reason, REASONS.INVALID_WORKLOAD_ID);
    const badMem = gov.admit(createWorkloadId("ok-id-1"), { workloadClass: "AGENT", memoryBytesHint: -5 });
    assert.equal(badMem.reason, REASONS.INVALID_DEMAND);
    const badCls = gov.admit(createWorkloadId("ok-id-2"), { workloadClass: "WAT" });
    assert.equal(badCls.reason, REASONS.INVALID_DEMAND);
    const st = gov.getResourceStatus();
    assert.equal(st.metrics.rejected, 3);
    assert.equal(st.activeLeases, 0);
});

test("admission: BACKGROUND queues at ELEVATED pressure while INTERACTIVE still admits", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, eventLoopLagMs: { elevated: 100, high: 500, critical: 900 } },
        observer: new FakeObserver({ eventLoopLagMs: 150 })
    });
    const bg = gov.admit(createWorkloadId("bg-1"), demand({ workloadClass: "BACKGROUND", priority: 20 }));
    assert.equal(bg.outcome, OUT.QUEUE);
    assert.notEqual(bg.reason, undefined);
    const inter = gov.admit(createWorkloadId("ui-1"), demand({ workloadClass: "INTERACTIVE" }));
    assert.equal(inter.outcome, OUT.ADMIT);
});

test("admission: CRITICAL pressure blocks heavy classes but not INTERACTIVE", () => {
    const gov = makeGovernor({
        config: BASE_CONFIG,
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    const heavy = gov.admit(createWorkloadId("re-big"),
        demand({ workloadClass: "RE_ANALYSIS", concurrencyGroup: "re-analysis" }));
    assert.notEqual(heavy.outcome, OUT.ADMIT);
    const inter = gov.admit(createWorkloadId("ui-hot"), demand({ workloadClass: "INTERACTIVE" }));
    assert.equal(inter.outcome, OUT.ADMIT);
    assert.notEqual(gov.getResourceStatus().pressureBand, PRESSURE_BANDS.UNKNOWN);
});

test("admission: severe event-loop lag defers heavy even when RAM is plentiful", () => {
    const clock = manualClock();
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, eventLoopLagMs: { elevated: 100, high: 250, critical: 900 } },
        observer: new FakeObserver({ eventLoopLagMs: 500 }),
        clock
    });
    const d = gov.admit(createWorkloadId("cpu-hog"), demand({ workloadClass: "AGENT" }));
    assert.equal(d.outcome, OUT.DEFER);
    assert.equal(d.reason, REASONS.DEFERRED_EVENT_LOOP_SEVERE);
});

test("admission: host memory hard ceiling rejects heavy outright", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, memoryThresholds: { hostHardFloorBytes: 1e9 } },
        observer: new FakeObserver({ totalMemBytes: 16e9, freeMemBytes: 0.5e9 })
    });
    const d = gov.admit(createWorkloadId("mem-hog"),
        demand({ workloadClass: "RE_ANALYSIS", memoryBytesHint: 1.5e9 }));
    assert.equal(d.outcome, OUT.REJECT_RESOURCE_LIMIT);
    assert.equal(d.reason, REASONS.MEMORY_HARD_CEILING);
});

test("admission: observer failure => UNKNOWN diagnostics, heavy defers, light admits", () => {
    const gov = makeGovernor({ config: BASE_CONFIG, observer: new ThrowingObserver() });
    const st0 = gov.getResourceStatus();
    assert.equal(st0.pressureBand, PRESSURE_BANDS.UNKNOWN);
    assert.equal(st0.observerHealthy, false);
    const heavy = gov.admit(createWorkloadId("ag-x"), demand());
    assert.equal(heavy.reason, REASONS.DEFERRED_OBSERVER_UNAVAILABLE);
    const light = gov.admit(createWorkloadId("tk-x"), demand({ workloadClass: "TOOL" }));
    assert.equal(light.outcome, OUT.ADMIT);
    assert.ok(st0.diagnostics.length >= 1);
});

test("admission: demand-based heaviness — CRITICAL + VOICE with huge memory hint is NOT admitted", () => {
    const gov = makeGovernor({
        config: BASE_CONFIG,
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    const d = gov.admit(createWorkloadId("voice-huge-mem"),
        demand({ workloadClass: "VOICE", memoryBytesHint: 1e9 }));
    assert.notEqual(d.outcome, OUT.ADMIT);
});

test("admission: demand-based heaviness — CRITICAL + TOOL with max cpuWeight is NOT admitted", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, heavyDemand: { cpuWeight: 80 } },
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    const d = gov.admit(createWorkloadId("tool-max-cpu"),
        demand({ workloadClass: "TOOL", cpuWeight: 100 }));
    assert.notEqual(d.outcome, OUT.ADMIT);
});

test("admission: demand-based heaviness — CRITICAL + INTERACTIVE with huge duration is NOT admitted", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, heavyDemand: { durationMs: 600000 } },
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    const d = gov.admit(createWorkloadId("inter-marathon"),
        demand({ workloadClass: "INTERACTIVE", expectedDurationMs: 3600000 }));
    assert.notEqual(d.outcome, OUT.ADMIT);
});

test("admission: light VOICE keeps low-latency semantics under CRITICAL", () => {
    const gov = makeGovernor({
        config: BASE_CONFIG,
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    const d = gov.admit(createWorkloadId("voice-light"),
        demand({ workloadClass: "VOICE", cpuWeight: 5, memoryBytesHint: 1e6 }));
    assert.equal(d.outcome, OUT.ADMIT);
});

test("admission: demand-based heaviness applies to host hard-floor gate too", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, memoryThresholds: { hostHardFloorBytes: 1e9 }, maxQueue: 4 },
        observer: new FakeObserver({ totalMemBytes: 16e9, freeMemBytes: 0.5e9 })
    });
    const lightTool = gov.admit(createWorkloadId("floor-light-tool"),
        demand({ workloadClass: "TOOL", memoryBytesHint: 1e6 }));
    assert.notEqual(lightTool.outcome, OUT.REJECT_RESOURCE_LIMIT);
    const fatTool = gov.admit(createWorkloadId("floor-fat-tool"),
        demand({ workloadClass: "TOOL", memoryBytesHint: 900e6 }));
    assert.equal(fatTool.outcome, OUT.REJECT_RESOURCE_LIMIT);
    assert.equal(fatTool.reason, REASONS.MEMORY_HARD_CEILING);
});

test("admission: default hard floor — heavy VOICE/INTERACTIVE/TOOL rejected at 128 MiB free with DEFAULT config", () => {
    for (const cls of ["VOICE", "INTERACTIVE", "TOOL"]) {
        const gov = makeGovernor({
            config: {},
            observer: new FakeObserver({
                totalMemBytes: 16 * 1024 ** 3,
                freeMemBytes: 128 * 1024 * 1024
            })
        });
        assert.equal(gov.config.memoryThresholds.hostHardFloorBytes, 256 * 1024 * 1024,
            `${cls}: resolved default floor must be stored on the config`);
        const d = gov.admit(createWorkloadId(`floor-${cls.toLowerCase()}`),
            demand({ workloadClass: cls, memoryBytesHint: 1e9 }));
        assert.equal(d.outcome, OUT.REJECT_RESOURCE_LIMIT, `${cls} heavy must hit hard ceiling`);
        assert.equal(d.reason, REASONS.MEMORY_HARD_CEILING);
    }
});

test("admission: free memory above default floor does not reject heavy by the floor alone", () => {
    const gov = makeGovernor({
        config: { maxQueue: 8 },
        observer: new FakeObserver({
            totalMemBytes: 16 * 1024 ** 3,
            freeMemBytes: 1024 * 1024 ** 2
        })
    });
    const d = gov.admit(createWorkloadId("floor-not-hit"),
        demand({ workloadClass: "TOOL", memoryBytesHint: 900e6 }));
    assert.notEqual(d.reason, REASONS.MEMORY_HARD_CEILING);
});

test("admission: UNKNOWN band from malformed metrics fails closed for heavy work", () => {
    class GarbledObserver {
        observe() {
            return {
                totalMemBytes: NaN, freeMemBytes: NaN,
                rssBytes: NaN, heapUsedBytes: NaN, heapLimitBytes: NaN,
                externalBytes: NaN, arrayBuffersBytes: NaN,
                eventLoopLagMs: NaN
            };
        }
    }
    const gov = makeGovernor({ config: BASE_CONFIG, observer: new GarbledObserver() });
    assert.equal(gov.getResourceStatus().pressureBand, "UNKNOWN");
    assert.equal(gov.getResourceStatus().observerHealthy, true);

    const heavyVoice = gov.admit(createWorkloadId("unknown-heavy-voice"),
        demand({ workloadClass: "VOICE", memoryBytesHint: 1e9 }));
    assert.equal(heavyVoice.outcome, OUT.DEFER);
    assert.equal(heavyVoice.reason, REASONS.DEFERRED_OBSERVER_UNAVAILABLE);

    const lightTool = gov.admit(createWorkloadId("unknown-light-tool"),
        demand({ workloadClass: "TOOL", cpuWeight: 1 }));
    assert.equal(lightTool.outcome, OUT.ADMIT);
});

test("admission: string-typed metrics yield UNKNOWN and defer maximally-heavy demand", () => {
    class StringyObserver {
        observe() {
            return {
                totalMemBytes: "17179869184",
                freeMemBytes: "8589934592",
                rssBytes: "2147483648",
                heapUsedBytes: "1073741824",
                heapLimitBytes: "4294967296",
                externalBytes: "50000000",
                arrayBuffersBytes: "20000000",
                eventLoopLagMs: "5"
            };
        }
    }
    const gov = makeGovernor({ config: BASE_CONFIG, observer: new StringyObserver() });
    assert.equal(gov.getResourceStatus().pressureBand, "UNKNOWN");
    const d = gov.admit(createWorkloadId("stringy-heavy-tool"),
        demand({ workloadClass: "TOOL", cpuWeight: 100 }));
    assert.equal(d.outcome, OUT.DEFER);
    assert.equal(d.reason, REASONS.DEFERRED_OBSERVER_UNAVAILABLE);
});

test("admission: missing process-memory metrics make band UNKNOWN; heavy is deferred", () => {
    class PartialObserver {
        observe() {
            return { eventLoopLagMs: NaN };
        }
    }
    const gov = makeGovernor({ config: BASE_CONFIG, observer: new PartialObserver() });
    assert.equal(gov.getResourceStatus().pressureBand, "UNKNOWN");
    const d = gov.admit(createWorkloadId("partial-heavy-agent"), demand());
    assert.equal(d.outcome, OUT.DEFER);
    assert.equal(d.reason, REASONS.DEFERRED_OBSERVER_UNAVAILABLE);
});

test("admission: queue overflow produces explicit QUEUE_FULL rejection", () => {
    const gov = makeGovernor({
        config: { ...BASE_CONFIG, maxQueue: 2 },
        observer: new FakeObserver({ eventLoopLagMs: 2000 })
    });
    gov.admit(createWorkloadId("q-1"), demand());
    gov.admit(createWorkloadId("q-2"), demand());
    const overflow = gov.admit(createWorkloadId("q-3"), demand());
    assert.equal(overflow.outcome, OUT.REJECT_RESOURCE_LIMIT);
    assert.equal(overflow.reason, REASONS.QUEUE_FULL);
});
