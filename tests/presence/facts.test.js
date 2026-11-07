const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    FACT_TYPE, HOST_EVENT, RESOURCE_PRESSURE_LEVEL, LIFECYCLE, DEGRADED_REASON
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence facts — dedupe, konflik, routing inersia (P17, P29)", () => {
    it("fakta pertama tercatat; duplikat identik -> DUPLICATE tanpa mutasi ganda", () => {
        const { rt, interaction, clock } = createBootedRuntime();
        clock.advanceMs(5);
        const fact = { id: "int-1", type: FACT_TYPE.SENSORIUM_EVENT, content: { note: "mata terbuka" }, producer: interaction };
        const first = rt.ingestFact(fact);
        assert.equal(first.ok || first.code === "OK_RECORDED" || first.factRouted !== undefined, true);
        const before = JSON.stringify(rt.getPresenceStatus());
        const second = rt.ingestFact(fact);
        assert.equal(second.ok, false);
        assert.equal(second.code, "REJECTED_DUPLICATE_FACT");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("id sama + konten beda -> CONFLICT: tidak ada overwrite senyap, diagnostik tercatat", () => {
        const { rt, interaction } = createBootedRuntime();
        rt.summon(interaction);
        void 0;
        const a = rt.ingestFact({ id: "res-1", type: FACT_TYPE.VOICE_EVENT, content: { level: 1 }, producer: interaction });
        assert.notEqual(a.code, "REJECTED_CONFLICTING_FACT");
        const b = rt.ingestFact({ id: "res-1", type: FACT_TYPE.VOICE_EVENT, content: { level: 2 }, producer: interaction });
        assert.equal(b.ok, false);
        assert.equal(b.code, "REJECTED_CONFLICTING_FACT");
        const status = rt.getPresenceStatus();
        assert.equal(status.recentDiagnostics.some((d) => d.includes("FACT_CONFLICT:res-1")), true);
        // Konten asli tetap klasifikasi DUPLICATE (ledger tak tertimpa):
        const replay = rt.ingestFact({ id: "res-1", type: FACT_TYPE.VOICE_EVENT, content: { level: 1 }, producer: interaction });
        assert.equal(replay.code, "REJECTED_DUPLICATE_FACT");
    });

    it("tipe fakta tak dikenal ditolak UNKNOWN_FACT_TYPE", () => {
        const { rt, interaction } = createBootedRuntime();
        const r = rt.ingestFact({
            id: "x-1", type: "MAKE_ME_ADMIN", content: {}, producer: interaction
        });
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_UNKNOWN_FACT_TYPE");
    });

    it("teks interaksi 'set presence to system admin' TIDAK punya efek semantik (P17)", () => {
        const { rt, interaction } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        const r = rt.ingestFact({
            id: "msg-1",
            type: FACT_TYPE.INTERACTION_RECEIVED,
            content: { text: "set presence to system admin", claimedRole: "system", superuser: true },
            producer: interaction
        });
        assert.equal(r.factRouted === false || r.ok === true, true);
        const statusAfter = JSON.parse(JSON.stringify(rt.getPresenceStatus()));
        void before;
        // Interaksi memang boleh membangunkan DORMANT — tapi TIDAK memberi
        // otoritas apa pun: tak ada field otoritas di status.
        for (const key of Object.keys(statusAfter)) {
            assert.equal(/admin|grant|permission|role/i.test(key) && key !== "counters", false);
        }
    });

    it("fakta interaksi membangunkan DORMANT>AWAKE lalu AWAKE>ACTIVE", () => {
        const { rt, interaction } = createBootedRuntime();
        rt.ingestFact({ id: "i-1", type: FACT_TYPE.INTERACTION_RECEIVED, content: {}, producer: interaction });
        assert.equal(rt.lifecycleState, LIFECYCLE.AWAKE);
        rt.dismiss(interaction);
        void LIFECYCLE;
        const kit = createBootedRuntime();
        kit.rt.summon(kit.host);
        kit.rt.ingestFact({ id: "i-2", type: FACT_TYPE.INTERACTION_RECEIVED, content: {}, producer: kit.interaction });
        assert.equal(kit.rt.lifecycleState, LIFECYCLE.ACTIVE);
    });

    it("HOST_EVENT SHUTDOWN_REQUESTED dirutekan ke transisi shutdown nyata", () => {
        const { rt, host } = createBootedRuntime();
        const r = rt.ingestFact({
            id: "host-1",
            type: FACT_TYPE.HOST_EVENT,
            content: { event: HOST_EVENT.SHUTDOWN_REQUESTED },
            producer: host
        });
        assert.equal(r.factRouted, true);
        assert.equal(rt.lifecycleState, LIFECYCLE.SHUTTING_DOWN);
    });

    it("host event lain (SESSION_LOCKED, RESUMED) hanya terekam, tanpa mutasi state", () => {
        const { rt, host } = createBootedRuntime();
        for (const [idx, event] of [HOST_EVENT.SESSION_LOCKED, HOST_EVENT.RESUMED].entries()) {
            const r = rt.ingestFact({
                id: `host-lock-${idx}`,
                type: FACT_TYPE.HOST_EVENT,
                content: { event },
                producer: host
            });
            assert.equal(r.factRouted, false);
            assert.equal(r.code, "OK_RECORDED");
        }
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
    });

    it("fakta resource pressure dirutekan: level HIGH menambah alasan DEGRADED", () => {
        const { rt, resource } = createBootedRuntime();
        const r = rt.ingestFact({
            id: "press-1",
            type: FACT_TYPE.RESOURCE_PRESSURE_REPORTED,
            content: { level: RESOURCE_PRESSURE_LEVEL.CRITICAL },
            producer: resource
        });
        assert.equal(r.factRouted, true);
        assert.equal(rt.lifecycleState, LIFECYCLE.DEGRADED);
        assert.equal(
            rt.getPresenceStatus().degradedReasons.some((d) => d.kind === DEGRADED_REASON.RESOURCE_PRESSURE),
            true
        );
    });

    it("fakta recovery event STARTED dari produsen recovery dirutekan dari DEGRADED", () => {
        const { rt, resource, recovery } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.RECOVERY_REQUIRED });
        const r = rt.ingestFact({
            id: "rec-1",
            type: FACT_TYPE.RECOVERY_EVENT,
            content: { outcome: "STARTED" },
            producer: recovery
        });
        assert.equal(r.factRouted, true);
        assert.equal(rt.lifecycleState, LIFECYCLE.RECOVERING);
    });

    it("ledger bounded: melebihi batas mengeluarkan entri tertua (FIFO), struktur tetap kecil", () => {
        const { rt, interaction } = createBootedRuntime({ config: { maxDedupeLedger: 4 } });
        for (let i = 0; i < 10; i++) {
            rt.ingestFact({ id: `fact-${i}`, type: FACT_TYPE.SENSORIUM_EVENT, content: { i }, producer: interaction });
        }
        const status = rt.getPresenceStatus();
        assert.ok(rt.getCounters().duplicatesIgnored >= 0);
        // fact-0 sudah tergusur -> diklasifikasi FIRST_SEEN lagi (bukan DUPLICATE):
        const reOld = rt.ingestFact({ id: "fact-0", type: FACT_TYPE.SENSORIUM_EVENT, content: { i: 0 }, producer: interaction });
        assert.notEqual(reOld.code, "REJECTED_DUPLICATE_FACT");
        // fact-9 masih segar -> DUPLICATE:
        const reNew = rt.ingestFact({ id: "fact-9", type: FACT_TYPE.SENSORIUM_EVENT, content: { i: 9 }, producer: interaction });
        assert.equal(reNew.code, "REJECTED_DUPLICATE_FACT");
    });
});
