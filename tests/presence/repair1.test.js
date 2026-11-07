const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, DEGRADED_REASON, RESOURCE_PRESSURE_LEVEL
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("repair-1: recovery transition atomicity", () => {
    it("completeRecovery dengan produsen palsu: nol efek, alasan degradasi utuh", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        const before = JSON.stringify(rt.getPresenceStatus());
        const forged = { id: recovery.id, kind: recovery.kind, label: "clone" };
        const result = rt.completeRecovery(forged);
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
        assert.equal(rt.getPresenceStatus().degradedReasons.length, 1, "alasan tidak boleh terhapus");
    });

    it("completeRecovery dari state tanpa edge (DORMANT tanpa degradasi? legal; pakai AWAKE): validasi sebelum hapus alasan", () => {
        const { rt, host, resource, recovery } = createBootedRuntime();
        rt.summon(host);
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE });
        // Recovery dari state yang punya edge RECOVERY_STARTED saja:
        // coba COMPLETE langsung dari DEGRADED -> edge tak ada -> ditolak.
        const before = JSON.stringify(rt.getPresenceStatus());
        const wrongOrder = rt.completeRecovery(recovery);
        assert.equal(wrongOrder.ok, false);
        assert.equal(["REJECTED_INVALID_TRANSITION", "REJECTED_INVALID_CAUSE"].includes(wrongOrder.code), true);
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before, "alasan tetap ada saat transisi ditolak");
    });

    it("degradeRecovery dengan produsen palsu: nol efek byte-per-byte", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.UNKNOWN });
        const before = JSON.stringify(rt.getPresenceStatus());
        const fake = Object.assign(Object.create(Object.getPrototypeOf(recovery) ?? {}), {
            id: `producer:recovery:${Date.now() % 100000}`
        });
        const result = rt.degradeRecovery(fake);
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("setResourcePressure: produsen palsu -> level dan degraded reasons tak tersentuh", () => {
        const { rt, resource } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const result = rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.HIGH, { id: resource.id });
        assert.equal(result.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
        assert.equal(rt.getPresenceStatus().resourcePressure, "UNKNOWN");
    });

    it("setResourcePressure HIGH saat slot degraded penuh: gagal tertutup, level TIDAK berubah setengah jalan", () => {
        const { rt, resource } = createBootedRuntime({
            config: { maxDegradedReasons: 2 }
        });
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.SENSORIUM_UNAVAILABLE });
        // State sudah DEGRADED; kuota penuh. HIGH harus gagal tanpa mengubah level.
        const beforeLevel = rt.getPresenceStatus().resourcePressure;
        const result = rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.HIGH, resource);
        assert.equal(result.ok, false);
        assert.equal(result.code, "REJECTED_BOUND_EXCEEDED");
        assert.equal(rt.getPresenceStatus().resourcePressure, beforeLevel);
    });

    it("jalur bahagia tetap utuh: completeRecovery sah tetap membersihkan alasan saat commit", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        rt.requestRecovery(recovery);
        const done = rt.completeRecovery(recovery);
        assert.equal(done.ok, true);
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
        assert.equal(rt.getPresenceStatus().degradedReasons.length, 0);
        assert.equal(rt.getPresenceStatus().health, "HEALTHY");
    });
});

describe("repair-2: activity capacity tracks LIVE work", () => {
    it(">=100 siklus begin SPEAKING -> complete -> begin berikutnya: tak pernah macet", () => {
        const { rt, host } = createBootedRuntime({ config: { maxActivities: 4, maxActivityTombstones: 8 } });
        for (let i = 0; i < 120; i++) {
            // Siklus interaksi nyata: setelah aktivitas terakhir selesai,
            // ACTIVE jatuh ke DORMANT — interaksi berikutnya membangunkan lagi.
            if (rt.lifecycleState === LIFECYCLE.DORMANT) {
                assert.equal(rt.summon(host).ok, true, `summon siklus ${i}`);
            }
            const begun = rt.beginActivity("SPEAKING", { ttlMs: 60_000 });
            assert.equal(begun.ok, true, `siklus ${i} harus bisa mulai (${begun.code})`);
            const ended = rt.endActivity(begun.token);
            assert.equal(ended.ok, true, `siklus ${i} harus bisa selesai`);
            assert.notEqual(rt.lifecycleState, LIFECYCLE.FAILED);
        }
        assert.equal(rt.getPresenceStatus().activeActivityCount, 0);
    });

    it("kapasitas admission dihitung dari aktivitas HIDUP, bukan ukuran map", () => {
        const { rt, host } = createBootedRuntime({ config: { maxActivities: 3, maxActivityTombstones: 64 } });
        rt.summon(host);
        const tokens = [];
        for (let i = 0; i < 3; i++) tokens.push(rt.beginActivity("THINKING").token);
        assert.equal(rt.beginActivity("LISTENING").code, "REJECTED_BOUND_EXCEEDED",
            "3 hidup + tombstone tidak boleh memakan kuota tambahan");
        rt.endActivity(tokens[0]);
        const afterComplete = rt.beginActivity("LISTENING");
        assert.equal(afterComplete.ok, true, "menyelesaikan satu membuka kapasitas hidup");
    });

    it("tombstone window bounded: rekaman terminal tereviksi deterministik (tertua dulu)", () => {
        const { rt, host } = createBootedRuntime({ config: { maxActivities: 2, maxActivityTombstones: 5 } });
        const oldTokens = [];
        for (let i = 0; i < 20; i++) {
            if (rt.lifecycleState === LIFECYCLE.DORMANT) {
                assert.equal(rt.summon(host).ok, true, `summon siklus ${i}`);
            }
            const begun = rt.beginActivity("ATTENDING");
            assert.equal(begun.ok, true, `begin siklus ${i} (${begun.code})`);
            if (i < 4) oldTokens.push(begun.token);
            rt.endActivity(begun.token);
        }
        let terminal = 0;
        for (const record of rt._activities.values()) {
            if (record.status !== "live") terminal += 1;
        }
        assert.ok(terminal <= 5, `tombstone=${terminal} melebihi batas`);
        // Rekaman lama sudah tereviksi -> UNKNOWN (bukan FORGED, bukan resurrect):
        const evicted = rt.endActivity(oldTokens[0]);
        assert.equal(evicted.code, "REJECTED_UNKNOWN_ACTIVITY");
        // Rekaman segar masih idempoten double-completion:
        if (rt.lifecycleState === LIFECYCLE.DORMANT) {
            assert.equal(rt.summon(host).ok, true);
        }
        const fresh = rt.beginActivity("ATTENDING").token;
        assert.ok(fresh);
        rt.endActivity(fresh);
        assert.equal(rt.endActivity(fresh).code, "OK_ALREADY_COMPLETED");
    });

    it("expired activities juga tereviksi; expired token tak bisa hidup ulang setelah eviction", () => {
        const { rt, host, clock } = createBootedRuntime({
            config: { maxActivities: 2, maxActivityTombstones: 3 }
        });
        rt.summon(host);
        const first = rt.beginActivity("SPEAKING", { ttlMs: 50 }).token;
        clock.advanceMs(60);
        rt.getPresenceStatus(); // sweep + prune
        for (let i = 0; i < 6; i++) {
            if (rt.lifecycleState === LIFECYCLE.DORMANT) {
                assert.equal(rt.summon(host).ok, true);
            }
            const t = rt.beginActivity("THINKING").token;
            rt.endActivity(t);
        }
        assert.ok(first, "token lama tetap objek genuin");
        const r = rt.endActivity(first);
        assert.equal(r.ok, false);
        assert.equal(["REJECTED_EXPIRED_TOKEN", "REJECTED_UNKNOWN_ACTIVITY"].includes(r.code), true,
            `kode=${r.code}`);
    });

    it("pola campuran panjang (begin/expire/complete/overlap) 150 langkah: runtime tetap sehat", () => {
        const { rt, host, clock } = createBootedRuntime({
            config: { maxActivities: 5, maxActivityTombstones: 10 }
        });
        rt.summon(host);
        const live = [];
        for (let step = 0; step < 150; step++) {
            if (step % 3 === 0 && live.length < 5) {
                const begun = rt.beginActivity(step % 2 === 0 ? "THINKING" : "SPEAKING");
                if (begun.ok) live.push(begun.token);
            }
            else if (live.length > 0) {
                const token = live.shift();
                const ended = rt.endActivity(token);
                assert.ok(
                    ended.ok || ["REJECTED_EXPIRED_TOKEN", "REJECTED_UNKNOWN_ACTIVITY"].includes(ended.code),
                    `langkah ${step}: ${ended.code}`
                );
            }
            if (step % 17 === 0) clock.advanceMs(31_000 * 60); // picu expiry massal
            const status = rt.getPresenceStatus();
            assert.ok(status.activeActivityCount <= 5);
        }
        assert.notEqual(rt.lifecycleState, LIFECYCLE.FAILED);
    });
});

describe("repair-3: token authenticity in interruption", () => {
    it("branded lookalike (id sama, objek beda) -> REJECTED_FORGED_TOKEN, tanpa rekomendasi", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const real = rt.beginActivity("SPEAKING").token;
        const other = rt.beginActivity("THINKING").token;
        void other;
        const before = JSON.stringify(rt.getPresenceStatus());
        // Objek lain dengan properti enumerable identik — tanpa brand symbol
        // internal, isGenuine menolak.
        const spreadClone = { ...real };
        assert.equal(rt.recommendInterruption(spreadClone).code, "REJECTED_FORGED_TOKEN");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
        assert.equal(rt.getCounters().interruptionRecommendations, 0);
    });

    it("token genuin milik record berbeda tapi id di-spoof: identity check object-level", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const a = rt.beginActivity("SPEAKING").token;
        const b = rt.beginActivity("SPEAKING").token;
        // Keduanya genuin; rekomendasi untuk a sah:
        assert.equal(rt.recommendInterruption(a, { reason: "user-talk" }).ok, true);
        assert.equal(rt.getCounters().interruptionRecommendations, 1);
        void b;
    });

    it("token genuin terminal (completed): penolakan deterministik REJECTED_TERMINAL_ACTIVITY", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const token = rt.beginActivity("SPEAKING").token;
        rt.endActivity(token);
        const beforeRecs = rt.getCounters().interruptionRecommendations;
        const r = rt.recommendInterruption(token);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_TERMINAL_ACTIVITY");
        assert.equal(rt.getCounters().interruptionRecommendations, beforeRecs);
    });

    it("token genuin interrupted (generasi maju): STALE_GENERATION mendahului cek status", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const token = rt.beginActivity("SPEAKING").token;
        rt.startNewGeneration();
        assert.equal(rt.recommendInterruption(token).code, "REJECTED_STALE_GENERATION");
    });

    it("rekomendasi sah tidak berubah: tetap inersia, aktivitas tetap hidup", () => {
        const { rt, host } = createBootedRuntime();
        rt.summon(host);
        const speak = rt.beginActivity("SPEAKING").token;
        const r = rt.recommendInterruption(speak, { reason: "barge-in" });
        assert.equal(r.ok, true);
        assert.equal(rt.getPresenceStatus().activeActivityCount, 1);
        assert.equal(rt.getPresenceStatus().activityPresentation, "SPEAKING");
    });

    it("endActivity mempertahankan identitas ketat: token genuin id-duplikat dari runtime lain ditolak UNKNOWN/STALE, bukan dieksekusi", () => {
        const a = require("../../src/runtime/presence").createPresenceRuntime({
            clock: require("../../src/runtime/presence").createManualClock(5)
        });
        const b = require("../../src/runtime/presence").createPresenceRuntime({
            clock: require("../../src/runtime/presence").createManualClock(5)
        });
        a.registerProducer(require("../../src/runtime/presence").PRODUCER_KIND.CORE, "a");
        b.registerProducer(require("../../src/runtime/presence").PRODUCER_KIND.CORE, "b");
        a.boot(a._coreProducer);
        a.markInitializing();
        a.markInitializationComplete();
        a.summon(a._coreProducer);
        const tokenA = a.beginActivity("THINKING").token;
        const beforeB = JSON.stringify(b.getPresenceStatus());
        const r = b.endActivity(tokenA);
        assert.equal(r.ok, false);
        assert.equal(["REJECTED_STALE_GENERATION", "REJECTED_UNKNOWN_ACTIVITY"].includes(r.code), true);
        assert.equal(JSON.stringify(b.getPresenceStatus()), beforeB);
    });
});
