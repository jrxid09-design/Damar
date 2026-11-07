const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    DEGRADED_REASON, HEALTH, RESOURCE_PRESSURE_LEVEL, LIFECYCLE
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence degraded — merepresentasikan, bukan menyelesaikan (P12)", () => {
    it("ACTIVE>DEGRADED saat alasan dilaporkan; health DEGRADED", () => {
        const { rt, host, resource } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("THINKING");
        const r = rt.reportDegradation({
            producer: resource,
            kind: DEGRADED_REASON.MODEL_UNAVAILABLE
        });
        assert.equal(r.code, "OK_COMMITTED");
        assert.deepEqual([r.from, r.to], ["ACTIVE", "DEGRADED"]);
        const status = rt.getPresenceStatus();
        assert.equal(status.health, HEALTH.DEGRADED);
        assert.equal(status.degradedReasons.length, 1);
        // Aktivitas di bawahnya tetap terhitung — presence hanya representasi.
        assert.equal(status.activeActivityCount, 1);
    });

    it("kind tak dikenal / produsen palsu ditolak tanpa mutasi", () => {
        const { rt, resource } = createBootedRuntime();
        const before = JSON.stringify(rt.getPresenceStatus());
        assert.equal(rt.reportDegradation({ producer: resource, kind: "OWNER_ANGRY" }).code, "REJECTED_INVALID_ARGUMENT");
        assert.equal(rt.reportDegradation({
            producer: { id: resource.id },
            kind: DEGRADED_REASON.UNKNOWN
        }).code, "REJECTED_INVALID_PRODUCER");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("alasan sama (kind+detail) dedupe: noop kedua, tetap satu entri", () => {
        const { rt, resource } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.SENSORIUM_UNAVAILABLE, detail: "kamera" });
        const again = rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.SENSORIUM_UNAVAILABLE, detail: "kamera" });
        assert.equal(again.ok, true);
        assert.equal(again.code, "OK_NOOP");
        assert.equal(rt.getPresenceStatus().degradedReasons.length, 1);
    });

    it("beberapa alasan koeksisten dan bounded; melebihi batas gagal tertutup", () => {
        const { rt, resource } = createBootedRuntime({ config: { maxDegradedReasons: 2 } });
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE });
        const third = rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.UNKNOWN });
        assert.equal(third.ok, false);
        assert.equal(third.code, "REJECTED_BOUND_EXCEEDED");
        assert.equal(rt.getPresenceStatus().degradedReasons.length, 2);
    });

    it("menghapus sebagian alasan: tetap DEGRADED; menghapus semua: resume deterministik ke DORMANT", () => {
        const { rt, resource } = createBootedRuntime();
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE });
        const partial = rt.clearDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        assert.equal(partial.remaining, 1);
        assert.equal(rt.lifecycleState, LIFECYCLE.DEGRADED);
        const final = rt.clearDegradation({ producer: resource, kind: DEGRADED_REASON.DEPENDENCY_FAILURE });
        assert.deepEqual([final.from, final.to], [LIFECYCLE.DEGRADED, LIFECYCLE.DORMANT]);
        assert.equal(rt.getPresenceStatus().health, HEALTH.HEALTHY);
    });

    it("resume konvergen: aktivitas hidup menarik resume ke ACTIVE", () => {
        const { rt, host, resource } = createBootedRuntime();
        rt.summon(host);
        rt.beginActivity("THINKING");
        rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.MODEL_UNAVAILABLE });
        assert.equal(rt.lifecycleState, LIFECYCLE.DEGRADED);
        const final = rt.clearDegradation({
            producer: resource,
            kind: DEGRADED_REASON.MODEL_UNAVAILABLE
        });
        assert.deepEqual([final.from, final.to], [LIFECYCLE.DEGRADED, LIFECYCLE.ACTIVE]);
        assert.equal(rt.getPresenceStatus().activityPresentation, "THINKING");
    });

    it("DORMANT+DEGRADED valid: health DEGRADED walau state presentasi DEGRADED", () => {
        const { rt, resource } = createBootedRuntime();
        const r = rt.reportDegradation({ producer: resource, kind: DEGRADED_REASON.INTERACTION_CHANNEL_UNAVAILABLE });
        assert.deepEqual([r.from, r.to], ["DORMANT", "DEGRADED"]);
        const status = rt.getPresenceStatus();
        assert.equal(status.activityPresentation, "DEGRADED");
        assert.equal(status.health, "DEGRADED");
        assert.equal(status.lifecycleState, "DEGRADED");
    });

    it("clearDegradation untuk key yang tidak ada ditolak UNKNOWN_TARGET", () => {
        const { rt, resource } = createBootedRuntime();
        const r = rt.clearDegradation({ producer: resource, kind: DEGRADED_REASON.UNKNOWN, detail: "hantu" });
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_UNKNOWN_TARGET");
    });
});

describe("presence resource pressure — representasi saja (P15)", () => {
    it("HIGH menambahkan alasan RESOURCE_PRESSURE; level tercatat di status", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        const r = rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.HIGH, resource);
        assert.equal(r.code, "OK_COMMITTED");
        const status = rt.getPresenceStatus();
        assert.equal(status.resourcePressure, "HIGH");
        assert.equal(status.degradedReasons.some((d) => d.kind === "RESOURCE_PRESSURE"), true);
    });

    it("NORMAL menghapus alasan RESOURCE_PRESSURE (deterministik, set-based)", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.CRITICAL, resource);
        assert.equal(rt.lifecycleState, "DEGRADED");
        rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.NORMAL, resource);
        const status = rt.getPresenceStatus();
        assert.equal(status.resourcePressure, "NORMAL");
        assert.equal(status.degradedReasons.length, 0);
        assert.equal(status.lifecycleState, "AWAKE"); // summoned -> AWAKE
    });

    it("level invalid ditolak; pressure tidak pernah memberi admission resource", () => {
        const { rt, resource } = createBootedRuntime();
        const r = rt.setResourcePressure("TIDAK_ADA", resource);
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_INVALID_ARGUMENT");
        // Tidak ada API admission/grant yang diekspos presence:
        for (const forbidden of ["grant", "admit", "throttle", "allocate"]) {
            assert.equal(
                Object.keys(rt).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(rt)))
                    .some((key) => key.toLowerCase().includes(forbidden)),
                false,
                `presence tidak boleh punya API ${forbidden}`
            );
        }
    });

    it("ELEVATED tidak menjadikan DEGRADED — hanya HIGH/CRITICAL", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        rt.setResourcePressure(RESOURCE_PRESSURE_LEVEL.ELEVATED, resource);
        const status = rt.getPresenceStatus();
        assert.equal(status.resourcePressure, "ELEVATED");
        assert.equal(status.health, HEALTH.HEALTHY);
        assert.equal(status.degradedReasons.length, 0);
    });
});
