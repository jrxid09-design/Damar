const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE,
    ACTIVITY_MODE,
    ACTIVITY_PRESENTATION_PRECEDENCE,
    CAUSE,
    TRANSITIONS,
    DEGRADED_REASON,
    HEALTH,
    RESOURCE_PRESSURE_LEVEL,
    FACT_TYPE,
    HOST_EVENT
} = require("../../src/runtime/presence");

describe("presence states — himpunan kanon tertutup", () => {
    it("lifecycle tepat 11 state kanon", () => {
        assert.deepEqual(Object.keys(LIFECYCLE).sort(), [
            "ACTIVE", "AWAKE", "BOOTING", "DEGRADED", "DORMANT", "FAILED",
            "INITIALIZING", "OFFLINE", "RECOVERING", "SHUTTING_DOWN", "WAITING_FOR_OWNER"
        ]);
    });

    it("enum enum kanon beku (tidak bisa dimutasi)", () => {
        for (const table of [LIFECYCLE, ACTIVITY_MODE, CAUSE, DEGRADED_REASON, HEALTH,
            RESOURCE_PRESSURE_LEVEL, FACT_TYPE, HOST_EVENT]) {
            assert.equal(Object.isFrozen(table), true);
        }
    });

    it("aktivitas mode tepat 5 dan IDLE termasuk", () => {
        assert.deepEqual(Object.keys(ACTIVITY_MODE).sort(),
            ["ATTENDING", "IDLE", "LISTENING", "SPEAKING", "THINKING"]);
    });

    it("precedence presentasi: LISTENING > SPEAKING > THINKING > ATTENDING > IDLE", () => {
        assert.deepEqual([...ACTIVITY_PRESENTATION_PRECEDENCE],
            ["LISTENING", "SPEAKING", "THINKING", "ATTENDING", "IDLE"]);
    });
});

describe("presence transitions — graf legal", () => {
    const ALL = Object.values(LIFECYCLE);

    function can(from, to) {
        return TRANSITIONS.has(from, to);
    }

    it("jalur hidup dasar legal: OFFLINE>BOOTING>INITIALIZING>DORMANT>AWAKE>ACTIVE", () => {
        assert.equal(can(LIFECYCLE.OFFLINE, LIFECYCLE.BOOTING), true);
        assert.equal(can(LIFECYCLE.BOOTING, LIFECYCLE.INITIALIZING), true);
        assert.equal(can(LIFECYCLE.INITIALIZING, LIFECYCLE.DORMANT), true);
        assert.equal(can(LIFECYCLE.DORMANT, LIFECYCLE.AWAKE), true);
        assert.equal(can(LIFECYCLE.AWAKE, LIFECYCLE.ACTIVE), true);
    });

    it("lompatan ilegal ditolak struktur graf (bukan runtime)", () => {
        assert.equal(can(LIFECYCLE.OFFLINE, LIFECYCLE.ACTIVE), false);
        assert.equal(can(LIFECYCLE.OFFLINE, LIFECYCLE.SPEAKING ?? "SPEAKING"), false);
        assert.equal(can(LIFECYCLE.DORMANT, LIFECYCLE.ACTIVE), false);
        assert.equal(can(LIFECYCLE.AWAKE, LIFECYCLE.OFFLINE), false);
        assert.equal(can(LIFECYCLE.ACTIVE, LIFECYCLE.BOOTING), false);
        assert.equal(can(LIFECYCLE.OFFLINE, LIFECYCLE.DEGRADED), false);
    });

    it("SHUTTING_DOWN hanya menuju OFFLINE", () => {
        for (const target of ALL) {
            if (target === LIFECYCLE.OFFLINE) continue;
            assert.equal(can(LIFECYCLE.SHUTTING_DOWN, target), false,
                `SHUTTING_DOWN -> ${target} harus ilegal`);
        }
        assert.equal(can(LIFECYCLE.SHUTTING_DOWN, LIFECYCLE.OFFLINE), true);
    });

    it("FAILED terminal: tidak ada edge keluar", () => {
        for (const target of ALL) {
            assert.equal(can(LIFECYCLE.FAILED, target), false);
        }
    });

    it("setiap state alive punya jalur SHUTTING_DOWN", () => {
        for (const from of ALL) {
            if ([LIFECYCLE.OFFLINE, LIFECYCLE.FAILED, LIFECYCLE.SHUTTING_DOWN].includes(from)) continue;
            assert.equal(can(from, LIFECYCLE.SHUTTING_DOWN), true, `alive ${from} harus bisa shutdown`);
        }
    });

    it("tidak ada self-loop di graf", () => {
        for (const from of ALL) {
            assert.equal(can(from, from), false, `self-loop ${from} dilarang`);
        }
    });

    it("kombinasi mustahil tak terwakili: state mati tak pernah menuju kehidupan langsung", () => {
        // Aktivitas bukan state lifecycle — kombinasi lintas hierarki
        // seperti SPEAKING+OFFLINE mustahil dibangun karena beginActivity
        // hanya sah saat AWAKE/ACTIVE/WAITING_FOR_OWNER.
        const living = [
            LIFECYCLE.DORMANT, LIFECYCLE.AWAKE, LIFECYCLE.ACTIVE,
            LIFECYCLE.WAITING_FOR_OWNER, LIFECYCLE.DEGRADED, LIFECYCLE.RECOVERING
        ];
        for (const dead of [LIFECYCLE.OFFLINE, LIFECYCLE.SHUTTING_DOWN, LIFECYCLE.FAILED]) {
            for (const target of living) {
                assert.equal(can(dead, target), false,
                    `${dead} -> ${target} harus ilegal`);
            }
        }
    });

    it("sebab transisi dipetakan per-edge: DORMANT>AWAKE menerima USER_SUMMON, menolak FATAL_FAILURE", () => {
        const causes = TRANSITIONS.causesFor(LIFECYCLE.DORMANT, LIFECYCLE.AWAKE);
        assert.equal(causes.has(CAUSE.USER_SUMMON), true);
        assert.equal(causes.has(CAUSE.INTERACTION_RECEIVED), true);
        assert.equal(causes.has(CAUSE.FATAL_FAILURE), false);
    });

    it("DEGRADED>RECOVERING butuh RECOVERY_STARTED; RECOVERING>DORMANT butuh RECOVERY_COMPLETED", () => {
        assert.equal(TRANSITIONS.causesFor(LIFECYCLE.DEGRADED, LIFECYCLE.RECOVERING).has(CAUSE.RECOVERY_STARTED), true);
        assert.equal(TRANSITIONS.causesFor(LIFECYCLE.RECOVERING, LIFECYCLE.DORMANT).has(CAUSE.RECOVERY_COMPLETED), true);
        assert.equal(TRANSITIONS.causesFor(LIFECYCLE.RECOVERING, LIFECYCLE.DORMANT).has(CAUSE.RECOVERY_STARTED), false);
    });

    it("resume dari DEGRADED mencakup semua target turunan", () => {
        for (const target of ["DORMANT", "AWAKE", "ACTIVE", "WAITING_FOR_OWNER"]) {
            const causes = TRANSITIONS.causesFor(LIFECYCLE.DEGRADED, target);
            assert.equal(causes.has(CAUSE.DEGRADATION_CLEARED), true, `DEGRADED->${target}`);
        }
    });

    it("graf berisi edge SHUTTING_DOWN>OFFLINE dengan sebab PROCESS_EXIT saja", () => {
        const causes = [...TRANSITIONS.causesFor(LIFECYCLE.SHUTTING_DOWN, LIFECYCLE.OFFLINE)];
        assert.deepEqual(causes, [CAUSE.PROCESS_EXIT]);
    });

    it("graf punya ukuran wajar (>25 edge, <60)", () => {
        assert.ok(TRANSITIONS.edgeCount > 25 && TRANSITIONS.edgeCount < 60,
            `edgeCount=${TRANSITIONS.edgeCount}`);
    });
});
