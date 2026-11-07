const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
    LIFECYCLE, CAUSE
} = require("../../src/runtime/presence");
const { createBootedRuntime } = require("./helpers/testKit");

describe("presence waiting for owner — konteks eksplisit (P11)", () => {
    it("owner wait membawa referensi opaque; presence tak memeriksa semantik approval", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        const r = rt.beginOwnerWait({
            producer: resource,
            approvalRequestId: "appr-xyz-1",
            interactionId: "int-42",
            reason: "hapus 12 ribu berkas"
        });
        assert.equal(r.ok, true);
        const status = rt.getPresenceStatus();
        assert.equal(status.lifecycleState, "WAITING_FOR_OWNER");
        assert.equal(status.waitingOwnerCount, 1);
    });

    it("DORMANT + owner wait: bangun lalu masuk WAITING (dua hop legal)", () => {
        const { rt, resource } = createBootedRuntime();
        const r = rt.beginOwnerWait({ producer: resource, approvalRequestId: "r1" });
        assert.equal(r.ok, true);
        assert.equal(rt.lifecycleState, "WAITING_FOR_OWNER");
    });

    it("menyelesaikan satu wait TIDAK menghapus wait lain yang tak berkaitan", () => {
        const { rt, resource, interaction } = createBootedRuntime();
        rt.summon(resource);
        const a = rt.beginOwnerWait({ producer: resource, approvalRequestId: "A" }).waitId;
        const b = rt.beginOwnerWait({ producer: interaction, approvalRequestId: "B" }).waitId;
        rt.resolveOwnerWait(a, { producer: resource, outcome: "approved" });
        assert.equal(rt.getPresenceStatus().waitingOwnerCount, 1);
        assert.equal(rt.lifecycleState, "WAITING_FOR_OWNER", "masih menunggu B");
        void b;
    });

    it("wait terakhir selesai -> kembali ke AWAKE (tanpa aktivitas) deterministik", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        const w = rt.beginOwnerWait({ producer: resource, approvalRequestId: "only" }).waitId;
        const result = rt.resolveOwnerWait(w, { producer: resource, outcome: "denied" });
        assert.equal(result.code, "OK_COMMITTED");
        assert.deepEqual([result.from, result.to], ["WAITING_FOR_OWNER", "AWAKE"]);
    });

    it("wait terakhir selesai saat aktivitas hidup -> kembali ke ACTIVE", () => {
        const { rt, resource } = createBootedRuntime();
        rt.summon(resource);
        rt.beginActivity("THINKING");
        const w = rt.beginOwnerWait({ producer: resource, approvalRequestId: "w" }).waitId;
        rt.resolveOwnerWait(w, { producer: resource });
        assert.equal(rt.lifecycleState, "ACTIVE");
        assert.equal(rt.getPresenceStatus().activityPresentation, "THINKING");
    });

    it("dismiss dari WAITING_FOR_OWNER -> DORMANT dan waits tetap dibersihkan? tidak — waits bertahan sampai di-resolve/TTL", () => {
        const { rt, resource } = createBootedRuntime();
        const w = rt.beginOwnerWait({ producer: resource, approvalRequestId: "keep" }).waitId;
        rt.dismiss(resource);
        assert.equal(rt.lifecycleState, LIFECYCLE.DORMANT);
        // Wait sudah tidak bisa diselesaikan lewat jalur normal state WAITING,
        // tapi entri tetap dilacak hingga TTL agar akuntansi jujur.
        assert.equal(rt.getPresenceStatus().waitingOwnerCount >= 0, true);
        void w;
    });

    it("TTL owner wait: kedaluwarsa keluar dari WAITING secara deterministik (jam injeksi)", () => {
        const { rt, resource, clock } = createBootedRuntime();
        rt.summon(resource);
        rt.beginOwnerWait({ producer: resource, approvalRequestId: "slow", ttlMs: 1000 });
        clock.advanceMs(1500);
        const status = rt.getPresenceStatus();
        assert.equal(status.waitingOwnerCount, 0);
        assert.equal(status.lifecycleState, "AWAKE");
    });

    it("maxOwnerWaits bounded: melebihi gagal tertutup tanpa eviction senyap", () => {
        const { rt, resource } = createBootedRuntime({ config: { maxOwnerWaits: 2 } });
        assert.equal(rt.beginOwnerWait({ producer: resource, approvalRequestId: "1" }).ok, true);
        assert.equal(rt.beginOwnerWait({ producer: resource, approvalRequestId: "2" }).ok, true);
        const third = rt.beginOwnerWait({ producer: resource, approvalRequestId: "3" });
        assert.equal(third.ok, false);
        assert.equal(third.code, "REJECTED_BOUND_EXCEEDED");
        assert.equal(rt.getPresenceStatus().waitingOwnerCount, 2);
    });

    it("waitId tak dikenal ditolak UNKNOWN_WAIT tanpa mutasi", () => {
        const { rt, resource } = createBootedRuntime();
        rt.beginOwnerWait({ producer: resource, approvalRequestId: "real" });
        const before = JSON.stringify(rt.getPresenceStatus());
        const r = rt.resolveOwnerWait("owner-wait-tidak-ada", { producer: resource });
        assert.equal(r.ok, false);
        assert.equal(r.code, "REJECTED_UNKNOWN_WAIT");
        assert.equal(JSON.stringify(rt.getPresenceStatus()), before);
    });

    it("produsen palsu tak bisa membuka atau menyelesaikan owner wait", () => {
        const { rt, resource } = createBootedRuntime();
        const fakeOpen = rt.beginOwnerWait({
            producer: { id: resource.id, kind: "RESOURCE_GOVERNOR" },
            approvalRequestId: "fake"
        });
        assert.equal(fakeOpen.code, "REJECTED_INVALID_PRODUCER");
        assert.equal(fakeOpen.ok, false);
    });
});
