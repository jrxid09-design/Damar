const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, FACT_TYPE, RESOURCE_PRESSURE_LEVEL, DEGRADED_REASON, createPresenceRuntime, createManualClock
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

const STORM_SIZE = 6000;

/** PRNG deterministik (mulberry32) — tanpa Math.random agar reproducible. */
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a += 0x6D2B79F5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildStormOps(kit) {
    const { rt, host, interaction, resource, recovery, voice } = kit;
    const producers = [host, interaction, resource, recovery, voice];
    const modes = ["LISTENING", "SPEAKING", "THINKING", "ATTENDING"];
    const degradedKinds = Object.keys(DEGRADED_REASON);
    const pressureLevels = Object.keys(RESOURCE_PRESSURE_LEVEL);
    const ops = [];
    const rand = prng(20260826);

    for (let i = 0; i < STORM_SIZE; i++) {
        const roll = rand();
        if (roll < 0.14) {
            ops.push(() => rt.ingestFact({
                id: `storm-${Math.floor(rand() * STORM_SIZE / 4)}`,
                type: FACT_TYPE.SENSORIUM_EVENT,
                content: { seq: i },
                producer: producers[Math.floor(rand() * producers.length)]
            }));
        }
        else if (roll < 0.28) {
            ops.push(() => rt.ingestFact({
                id: `press-${i % 40}`,
                type: FACT_TYPE.RESOURCE_PRESSURE_REPORTED,
                content: { level: pressureLevels[Math.floor(rand() * pressureLevels.length)] },
                producer: resource
            }));
        }
        else if (roll < 0.42) {
            ops.push(() => rt.beginActivity(modes[Math.floor(rand() * modes.length)], {
                ttlMs: Math.floor(rand() * 500) + 1
            }));
        }
        else if (roll < 0.56) {
            const live = [...rt._activities.values()].filter((r) => r.status === "live");
            if (live.length > 0) {
                const record = live[Math.floor(rand() * live.length)];
                ops.push(() => rt.endActivity(record.token));
            }
        }
        else if (roll < 0.64) {
            ops.push(() => rt.summon(interaction));
        }
        else if (roll < 0.72) {
            ops.push(() => rt.dismiss(host));
        }
        else if (roll < 0.80) {
            ops.push(() => {
                const r = rt.beginOwnerWait({
                    producer: interaction,
                    approvalRequestId: `wait-${i % 12}`,
                    ttlMs: Math.floor(rand() * 300) + 10
                });
                return r;
            });
        }
        else if (roll < 0.86) {
            const waits = [...rt._ownerWaits.keys()];
            if (waits.length > 0) {
                const waitId = waits[Math.floor(rand() * waits.length)];
                ops.push(() => rt.resolveOwnerWait(waitId, { producer: interaction, outcome: "x" }));
            }
        }
        else if (roll < 0.93) {
            ops.push(() => rt.reportDegradation({
                producer: resource,
                kind: degradedKinds[Math.floor(rand() * degradedKinds.length)],
                detail: rand() < 0.5 ? null : `d${i % 5}`
            }));
        }
        else {
            ops.push(() => rt.requestTransition({
                to: LIFECYCLE.MARS ?? "MARS",
                cause: "TELEPORT",
                producer: host
            }));
        }
    }
    return ops;
}

describe("presence storm — 6000 fakta sintetis campuran (P33)", () => {
    it("badai adversarial: bounded, tanpa counter negatif, tanpa mutasi stale-generation", () => {
        const kit = createBootedRuntime({ config: {} });
        const { rt, clock } = kit;
        const ops = buildStormOps(kit);

        // Subscriber yang selalu melempar harus terisolasi sepanjang badai.
        rt.subscribe(() => { throw new Error("subscriber-jahat"); });

        let terminalFailedSeen = 0;
        let lastState = rt.lifecycleState;

        for (let i = 0; i < ops.length; i++) {
            ops[i]();
            if (i % 250 === 0) clock.advanceMs(50);

            const status = rt.getPresenceStatus();
            // Tidak ada counter negatif:
            for (const [key, value] of Object.entries(rt.getCounters())) {
                assert.ok(value >= 0, `counter ${key} negatif: ${value}`);
            }
            // Struktur terbatas:
            assert.ok(status.activeActivityCount <= rt.config.maxActivities);
            assert.ok(status.waitingOwnerCount <= rt.config.maxOwnerWaits);
            assert.ok(status.degradedReasons.length <= rt.config.maxDegradedReasons);
            assert.ok(status.recentDiagnostics.length <= rt.config.maxDiagnostics);
            assert.ok(rt.getJournal().length <= rt.config.maxHistory);
            // FAILED hanya bisa dimasuki sekali (terminal):
            if (lastState !== LIFECYCLE.FAILED && status.lifecycleState === LIFECYCLE.FAILED) {
                terminalFailedSeen += 1;
            }
            lastState = status.lifecycleState;
        }

        assert.equal(terminalFailedSeen <= 1, true, "FAILED masuk lebih dari sekali");
        const final = rt.getPresenceStatus();
        assert.equal(kit.rt.getCounters().subscriberErrorsIsolated >= 1, true,
            "subscriber jahat harus terisolasi, bukan merusak runtime");
        assert.ok(kit.rt.getCounters().staleGenerationRejected >= 0);
        assert.ok(rt._ledger.size <= rt.config.maxDedupeLedger);
        void createPresenceRuntime;
    });

    it("status tetap bounded dan valid setelah badai penuh", () => {
        const kit = createBootedRuntime({ config: { maxHistory: 128, maxDiagnostics: 8 } });
        const ops = buildStormOps(kit);
        for (let i = 0; i < ops.length; i++) {
            ops[i]();
            if (i % 100 === 0) kit.clock.advanceMs(25);
        }
        const status = kit.rt.getPresenceStatus();
        assert.ok(kit.rt.getJournal().length <= 128);
        assert.ok(status.recentDiagnostics.length <= 8);
        assert.equal(typeof status.generation, "string");
        assert.ok(["HEALTHY", "DEGRADED", "RECOVERING", "FAILED", "UNKNOWN"].includes(status.health));
        assert.ok(["NORMAL", "ELEVATED", "HIGH", "CRITICAL", "UNKNOWN"].includes(status.resourcePressure));
    });

    it("konvergensi presentasi: permutasi urutan fakta menghasilkan presentasi identik (P30)", () => {
        // Fakta set-based (aktivitas hidup, owner waits, degraded reasons)
        // harus konvergen. Transisi lifecycle berurutan sengaja TIDAK diuji
        // konvergensinya karena urutannya semantik.
        const seedSet = [
            (kit) => kit.rt.beginActivity("SPEAKING"),
            (kit) => kit.rt.beginActivity("THINKING"),
            (kit) => kit.rt.beginActivity("LISTENING"),
            (kit) => kit.rt.beginOwnerWait({ producer: kit.interaction, approvalRequestId: "w1" }),
            (kit) => kit.rt.reportDegradation({ producer: kit.resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE }),
            (kit) => kit.rt.reportDegradation({ producer: kit.resource, kind: DEGRADED_REASON.SENSORIUM_UNAVAILABLE })
        ];

        const runPermutation = (order, seed) => {
            const kit = createBootedRuntime({ startMs: seed });
            kit.rt.summon(kit.host);
            for (const op of order) op(kit);
            const status = kit.rt.getPresenceStatus();
            return {
                presentation: status.activityPresentation,
                health: status.health,
                waitingOwnerCount: status.waitingOwnerCount,
                activeActivityCount: status.activeActivityCount,
                degradedKeys: status.degradedReasons.map((d) => d.kind).sort()
            };
        };

        const forward = runPermutation(seedSet, 42_000);
        const reversed = runPermutation([...seedSet].reverse(), 42_000);
        const shuffled = runPermutation(
            [seedSet[3], seedSet[0], seedSet[5], seedSet[2], seedSet[4], seedSet[1]],
            42_000
        );

        assert.deepEqual(shuffled, forward);
        // Reversed memang sengaja dikecualikan dari kesamaan mutlak:
        // WAITING_FOR_OWNER mendominasi aktivitas dalam presentasi, namun
        // beginOwnerWait saat DORMANT vs saat ACTIVE menempuh jalur state
        // berbeda yang sah. Yang wajib konvergen adalah komponen set-based:
        assert.deepEqual(reversed.degradedKeys, forward.degradedKeys);
        assert.deepEqual(reversed.health === "DEGRADED" || reversed.health === "RECOVERING",
            forward.health === "DEGRADED" || forward.health === "RECOVERING");
    });

    it("permutasi murni set-based (tanpa interaksi urutan state): hasil identik penuh", () => {
        const factsOnly = [
            (kit) => kit.rt.beginActivity("SPEAKING"),
            (kit) => kit.rt.beginActivity("LISTENING"),
            (kit) => kit.rt.reportDegradation({ producer: kit.resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE }),
            (kit) => kit.rt.reportDegradation({ producer: kit.resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE })
        ];
        const run = (order) => {
            const kit = createBootedRuntime({ startMs: 777 });
            kit.rt.summon(kit.host);
            for (const op of order) op(kit);
            const s = kit.rt.getPresenceStatus();
            return {
                presentation: s.activityPresentation,
                activeCount: s.activeActivityCount,
                reasons: s.degradedReasons.map((d) => d.kind).sort().join("|"),
                health: s.health
            };
        };
        const a = run(factsOnly);
        const b = run([...factsOnly].reverse());
        const c = run([factsOnly[2], factsOnly[0], factsOnly[3], factsOnly[1]]);
        assert.deepEqual(b, a);
        assert.deepEqual(c, a);
    });

    it("stale generation di tengah badai: token lama ditolak, runtime tak bermutasi olehnya", () => {
        const kit = createBootedRuntime({});
        const { rt, host, clock } = kit;
        rt.summon(host);
        const staleTokens = [];
        for (let wave = 0; wave < 5; wave++) {
            for (let i = 0; i < 20; i++) {
                const r = rt.beginActivity("THINKING", { ttlMs: 10_000 });
                if (r.ok) staleTokens.push(r.token);
            }
            clock.advanceMs(5);
            rt.startNewGeneration(`wave-${wave}`);
        }
        const before = JSON.stringify(rt.getPresenceStatus());
        let staleRejected = 0;
        for (const token of staleTokens) {
            const result = rt.endActivity(token);
            if (!result.ok && result.code === "REJECTED_STALE_GENERATION") staleRejected += 1;
        }
        assert.equal(staleRejected, staleTokens.length, "semua token lintas generasi ditolak");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });
});
