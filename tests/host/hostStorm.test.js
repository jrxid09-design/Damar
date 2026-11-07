"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");

// ---------------------------------------------------------------- helpers

/** RNG deterministik agar kegagalan bisa direproduksi. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TOTAL_OPS = 5200;

async function settle(ms = 0) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

test("STORM 5000+: lifecycle/interaksi campuran — bounded, tanpa korupsi, tanpa authority", async () => {
    const host = await createRuntimeHost({ coreOptions: {} });
    const rand = mulberry32(20260826);

    const stats = {
        summon: 0, dismiss: 0, command: 0, message: 0, malformed: 0,
        cancel: 0, activity: 0, pressure: 0, restartGen: 0, reconnect: 0
    };

    const adapters = new Map();
    let adapterSeq = 0;
    let msgSeq = 0;

    try {
        for (let op = 0; op < TOTAL_OPS; op++) {
            const roll = rand();

            if (roll < 0.10) {
                host.summon({ source: "storm" }); stats.summon++;
            } else if (roll < 0.20) {
                host.dismiss({ source: "storm" }); stats.dismiss++;
            } else if (roll < 0.40) {
                const cmd = ["summon", "dismiss", "status", "shutdown", "hax"][Math.floor(rand() * 5)];
                if (cmd === "shutdown") {
                    // shutdown via bus hanya di luar storm; ganti status.
                    host.submitLocal({ kind: "COMMAND", payload: { command: "status" } });
                } else {
                    host.submitLocal({ kind: "COMMAND", payload: { command: cmd } });
                }
                stats.command++;
            } else if (roll < 0.62) {
                if (adapters.size === 0 || (rand() < 0.05 && adapters.size < 4)) {
                    const id = `storm.transport.t${adapterSeq++}`;
                    adapters.set(id, host.attachTransportAdapter({
                        transportId: id,
                        origin: ["API", "TEST", "VOICE"][adapterSeq % 3]
                    }).adapter);
                    stats.reconnect++;
                }
                const ids = [...adapters.keys()];
                const adapter = adapters.get(ids[Math.floor(rand() * ids.length)]);
                const r = adapter.ingestExternalEvent({
                    text: `pesan-${msgSeq++}`,
                    userId: `user-${Math.floor(rand() * 6)}`
                });
                if (r.accepted) stats.message++;
            } else if (roll < 0.70) {
                const ids = [...adapters.keys()];
                if (ids.length > 0) {
                    const id = ids[Math.floor(rand() * ids.length)];
                    const adapter = adapters.get(id);
                    const garbage = [null, {}, { text: "" }, { userId: {} }, [], 7];
                    adapter.ingestExternalEvent(garbage[Math.floor(rand() * garbage.length)]);
                    stats.malformed++;
                }
            } else if (roll < 0.76) {
                const modes = ["ATTENDING", "LISTENING", "THINKING", "SPEAKING"];
                const started = host.beginActivity(modes[Math.floor(rand() * modes.length)], {});
                if (started.ok && rand() < 0.7) {
                    try { host.endActivity(started.token, { reason: "storm" }); } catch { /* kedaluwarsa */ }
                }
                stats.activity++;
            } else if (roll < 0.82) {
                const kinds = [
                    { kind: presenceKind(host), detail: "storm" },
                    null
                ];
                const pick = kinds[Math.floor(rand() * 2)];
                if (pick) host.reportDegradation(pick); else host.clearDegradation({});
                stats.pressure++;
            } else if (roll < 0.85) {
                const rec = host.fail({ reason: "storm-fail" });
                if (rec.ok) host.recoverNow({ reason: "storm-recover" });
                stats.restartGen++;
            } else if (roll < 0.92) {
                // Cancel acak terhadap interaksi terakhir yang dikenal.
                const r = host.submitLocal({
                    kind: "MESSAGE",
                    payload: { text: `cancel-bait-${op}` },
                    metadata: undefined
                });
                void r;
                if (r.interactionId) {
                    try { host.core.bus.requestCancellation(r.interactionId, "storm"); } catch { /* sudah final */ }
                }
                stats.cancel++;
            } else {
                host.submitLocal({ kind: "STATUS_REQUEST", payload: {} });
                stats.command++;
            }

            // Pump berkala supaya antrean tidak menumpuk tak terkendali.
            if (op % 25 === 0) {
                host.core.bus.pump();
                await settle(op % 200 === 0 ? 1 : 0);
            }
            if (op % 500 === 0) host.core.bus.sweep(Date.now());

            // Host tidak boleh wedged: selalu ada respons terhadap health().
            if (op % 1000 === 999) {
                const h = host.health();
                assert.equal(typeof h.healthy, "boolean", `health rusak di op ${op}`);
            }
        }

        // Drain akhir.
        for (let i = 0; i < 50; i++) {
            host.core.bus.pump();
            await settle(2);
        }
        host.core.bus.sweep(Date.now());

        console.log("STORM STATS:", JSON.stringify(stats));

        // ------------------------------------------------------ INVARIAN

        const busStatus = host.core.bus.getStatus();
        assert.equal(busStatus.pendingInteractions, 0,
            "tidak boleh ada interaksi menggantung setelah drain");
        assert.equal(busStatus.inflight, 0, "tidak boleh stream menggantung");
        assert.ok(busStatus.counters.negativeCounterGuards === 0,
            "counter guard harus nol");
        assert.ok(busStatus.diagnosticsUsed <= 100, "diagnostik terbatas");

        // Struktur presence bounded & bersih.
        const p = host.core.presence.getPresenceStatus();
        assert.ok(p.degradedReasons.length <= 8, "degraded reasons bounded");

        // Authority tetap deny-by-default setelah badai.
        const registry = host.core.wave1.authority.registry;
        assert.equal((await registry.authorize({
            capabilityId: "storm.leak.probe", action: "use"
        })).allowed, false, "storm tidak boleh menciptakan authority");

        // Shutdown bersih + idempoten.
        const sd1 = host.shutdown("storm-end");
        assert.equal(sd1.shutDown, true);
        const sd2 = host.shutdown("storm-end");
        assert.equal(sd2.idempotent, true);
        assert.equal(host.phase, "TERMINATED");
    } finally {
        void host;
    }

    function presenceKind(h) {
        return {
            producer: h.core.presenceProducers.host,
            kind: "DEPENDENCY_FAILURE"
        };
    }
});
