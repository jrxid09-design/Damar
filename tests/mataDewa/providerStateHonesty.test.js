"use strict";

/**
 * Sertifikasi MD-009 — mesin status provider yang jujur.
 *
 * Bukti wajib:
 *  - Stub (tanpa poll/on-demand/probe) TIDAK PERNAH AVAILABLE — alasan
 *    "not_implemented" eksplisit.
 *  - On-demand tanpa bukti → "not_proven_yet"; sukses on-demand pertama
 *    = bukti hidup; kegagalan berulang = bukti mati.
 *  - health probe gagal → poll TIDAK menandai AVAILABLE (kepercayaan
 *    mengikuti bukti terburuk).
 *  - AVAILABLE yang basi (sukses terakhir melampaui jendela kesegaran)
 *    dilaporkan DEGRADED + stale:true — kepercayaan melapak seiring waktu.
 *  - Kegagalan poll berulang → UNAVAILABLE dengan failureReason nyata.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { ProviderRegistry, PROVIDER_STATE } = require("../../src/mataDewa/registry/providerRegistry");

let clockNow = 1_700_000_000_000;
const clock = { nowMs: () => clockNow };

function freshRegistry() {
    clockNow = 1_700_000_000_000;
    return new ProviderRegistry({ clock });
}

test("MD-009: stub TIDAK PERNAH AVAILABLE — not_implemented eksplisit", async () => {
    const reg = freshRegistry();
    reg.registerProvider({ id: "aisstream", types: ["vessel"], accessMode: "API_KEY" });
    const result = await reg.pollProvider("aisstream");
    assert.equal(result.ok, false);
    assert.equal(result.state, PROVIDER_STATE.UNAVAILABLE);
    assert.equal(result.failureReason, "not_implemented");
    assert.equal(reg.describe("aisstream").availability, "unavailable");
    assert.equal(reg.describe("aisstream").failureReason, "not_implemented");
    // Probe juga menolak.
    const probe = await reg.probeProvider("aisstream");
    assert.equal(probe.ok, false);
    assert.equal(probe.failureReason, "not_implemented");
});

test("MD-009: on-demand tanpa bukti → not_proven_yet; sukses = AVAILABLE", async () => {
    const reg = freshRegistry();
    reg.registerProvider({
        id: "routing", types: ["route"], accessMode: "PUBLIC_NO_KEY",
        computeRoute: async () => ({ ok: true })
    });
    // Boot probe: belum terbukti.
    const initial = await reg.pollProvider("routing");
    assert.equal(initial.ok, false);
    assert.equal(initial.failureReason, "not_proven_yet");
    assert.equal(reg.describe("routing").availability, "unavailable");
    // Pemanggilan on-demand sukses = bukti hidup.
    const route = await reg.getProvider("routing").computeRoute({ lat: 0, lon: 0 });
    assert.deepEqual(route, { ok: true });
    assert.equal(reg.describe("routing").availability, "available");
    assert.equal(reg.describe("routing").failureReason, null);
});

test("MD-009: kegagalan on-demand berulang → UNAVAILABLE dengan alasan nyata", async () => {
    const reg = freshRegistry();
    reg.registerProvider({
        id: "routing-bad", types: ["route"], accessMode: "PUBLIC_NO_KEY",
        computeRoute: async () => { throw new Error("upstream 503"); }
    });
    const provider = reg.getProvider("routing-bad");
    await assert.rejects(() => provider.computeRoute({}));
    assert.equal(reg.describe("routing-bad").availability, "degraded");
    assert.match(reg.describe("routing-bad").failureReason, /503/);
    await assert.rejects(() => provider.computeRoute({}));
    assert.equal(reg.describe("routing-bad").availability, "unavailable");
});

test("MD-009: health probe gagal → poll TIDAK menandai AVAILABLE", async () => {
    const reg = freshRegistry();
    let pollCalls = 0;
    reg.registerProvider({
        id: "weather", types: ["weather"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => { pollCalls += 1; return []; },
        healthy: async () => false
    });
    const result = await reg.pollProvider("weather");
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, "health_probe_failed");
    assert.equal(reg.describe("weather").availability, "unavailable");
    // Probe sebelum poll → poll tidak dijalankan.
    assert.equal(pollCalls, 0);
    // Probe yang sembuh → poll berjalan normal.
    const reg2 = freshRegistry();
    let flip = false;
    reg2.registerProvider({
        id: "weather2", types: ["weather"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => [{ type: "weather", location: { lat: 0, lon: 0 }, observedAt: clockNow - 1000, confidence: 0.9 }],
        healthy: async () => flip
    });
    await reg2.pollProvider("weather2");
    assert.equal(reg2.describe("weather2").availability, "unavailable");
    flip = true;
    await reg2.pollProvider("weather2");
    assert.equal(reg2.describe("weather2").availability, "available");
});

test("MD-009: AVAILABLE basi dilaporkan DEGRADED + stale (kepercayaan melapak)", async () => {
    const reg = freshRegistry();
    reg.registerProvider({
        id: "usgs-like", types: ["earthquake"], accessMode: "PUBLIC_NO_KEY",
        freshnessMs: 60 * 1000,
        poll: async () => []
    });
    await reg.pollProvider("usgs-like");
    assert.equal(reg.describe("usgs-like").availability, "available");
    assert.equal(reg.describe("usgs-like").stale, false);
    // Waktu berjalan 31 menit tanpa sukses baru → efektif DEGRADED.
    clockNow += 31 * 60 * 1000;
    const described = reg.describe("usgs-like");
    assert.equal(described.availability, "degraded");
    assert.equal(described.stale, true);
    // State mentah tetap teraudit.
    assert.equal(reg.getProvider("usgs-like").state, "available");
});

test("MD-009: kegagalan poll berulang → UNAVAILABLE dengan failureReason nyata", async () => {
    const reg = freshRegistry();
    reg.registerProvider({
        id: "flaky", types: ["fire"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => { throw new Error("connection reset"); }
    });
    const first = await reg.pollProvider("flaky");
    assert.equal(first.ok, false);
    assert.equal(reg.describe("flaky").availability, "degraded");
    await reg.pollProvider("flaky");
    const described = reg.describe("flaky");
    assert.equal(described.availability, "unavailable");
    assert.match(described.failureReason, /connection reset/);
});

test("MD-009: describe mengekspos kapabilitas + jejak bukti (lastProbedAt/lastSuccessAt)", async () => {
    const reg = freshRegistry();
    reg.registerProvider({ id: "stub", types: ["x"], accessMode: "API_KEY" });
    const described = reg.describe("stub");
    assert.deepEqual(described.capabilities, { periodic: false, onDemand: false, probe: false });
    assert.equal(described.lastPollAt, null);
    assert.equal(described.lastSuccessAt, null);

    reg.registerProvider({
        id: "full", types: ["y"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => [], healthy: async () => true,
        computeRoute: async () => ({})
    });
    await reg.pollProvider("full");
    const full = reg.describe("full");
    assert.deepEqual(full.capabilities, { periodic: true, onDemand: true, probe: true });
    assert.ok(full.lastPollAt !== null);
    assert.ok(full.lastSuccessAt !== null);
    assert.ok(full.lastProbedAt !== null);
});

test("MD-009: boot Mata Dewa — stub tidak menghitung sebagai provider hidup", async () => {
    // Registry berisi HANYA stub → DEGRADED, bukan READY palsu.
    const { MataDewaService, SUBSYSTEM_STATE } = require("../../src/mataDewa/service");
    const composition = require("../../src/mataDewa/composition");
    composition.resetMataDewaServiceForTests();
    const service = new MataDewaService({ clock });
    service.registerProvider({ id: "stub-only", types: ["vessel"], accessMode: "API_KEY" });
    const status = await service.start();
    assert.equal(status.state, SUBSYSTEM_STATE.DEGRADED);
    assert.ok(status.degradationReasons.includes("no_provider_available_at_boot"));
    await service.shutdown();
    composition.resetMataDewaServiceForTests();
});
