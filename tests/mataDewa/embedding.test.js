/**
 * Sertifikasi Lane 5 — EMBEDDING & lifecycle.
 *
 * Mata Dewa embed di Damar: bukan aplikasi kedua, bukan port publik kedua,
 * bukan peluncuran kedua. Inti headless tetap hidup walau UI ditutup;
 * Damar shutdown menghentikan Mata Dewa.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { MataDewaService, UI_MODE, SUBSYSTEM_STATE } = require("../../src/mataDewa/service");
const { ProviderRegistry } = require("../../src/mataDewa/registry/providerRegistry");

const clock = { nowMs: () => 1759500000000 };

function syntheticProvider(id, type) {
    return {
        id,
        label: id,
        types: [type],
        accessMode: "PUBLIC_NO_KEY",
        coverage: { kind: "global" },
        poll: async () => [{
            id: `${id}_1`,
            type,
            geometry: { type: "point", lat: -6.6, lon: 106.8 },
            observedAt: clock.nowMs() - 1000,
            confidence: 0.9
        }]
    };
}

test("EMBEDDING: Damar start → Mata Dewa tersedia (start/ready/status/shutdown)", async () => {
    const service = new MataDewaService({ clock });
    service.registerProvider(syntheticProvider("p1", "earthquake"));
    const status = await service.start();
    assert.equal(status.state, SUBSYSTEM_STATE.READY);
    assert.ok(status.providerCount >= 1);
    const after = await service.shutdown();
    assert.equal(after.terminated, true);
    assert.equal(service.state, SUBSYSTEM_STATE.TERMINATED);
});

test("EMBEDDING: tidak ada langkah peluncuran kedua — service hidup tanpa UI", async () => {
    const service = new MataDewaService({ clock });
    await service.start();
    // Watch engine headless menyala tanpa UI mode MATA_DEWA.
    assert.equal(service.uiMode, UI_MODE.NORMAL);
    assert.equal(service.watchEngine.isRunning, true);
    await service.shutdown();
});

test("EMBEDDING: UI closed tidak mematikan watch engine (UI state ≠ core state)", async () => {
    const service = new MataDewaService({ clock });
    await service.start();
    service.activateMode();
    assert.equal(service.uiMode, UI_MODE.MATA_DEWA);
    service.deactivateMode();
    assert.equal(service.uiMode, UI_MODE.NORMAL);
    // Inti tetap hidup dan siap menerima query:
    assert.equal(service.watchEngine.isRunning, true);
    const result = await service.ask({ types: ["earthquake"] });
    assert.ok(Array.isArray(result.observations));
    await service.shutdown();
});

test("EMBEDDING: Damar shutdown menghentikan Mata Dewa (idempoten)", async () => {
    const service = new MataDewaService({ clock });
    await service.start();
    const s1 = await service.shutdown();
    const s2 = await service.shutdown();
    assert.equal(s1.terminated, true);
    assert.ok(s2.terminated || s2.already);
    assert.equal(service.watchEngine.isRunning, false);
});

test("EMBEDDING: aktivasi/deaktivasi mode UI dari jalur yang sama", async () => {
    const service = new MataDewaService({ clock });
    await service.start();
    assert.equal(service.activateMode().ok, true);
    assert.equal(service.uiMode, UI_MODE.MATA_DEWA);
    assert.equal(service.deactivateMode().ok, true);
    assert.equal(service.uiMode, UI_MODE.NORMAL);
    // Mode tidak dikenal ditolak.
    assert.equal(service.setUiMode("HACKED").ok, false);
    await service.shutdown();
});

test("EMBEDDING: kegagalan provider tidak membunuh Mata Dewa (degraded, bukan crash)", async () => {
    const service = new MataDewaService({ clock });
    service.registerProvider({
        id: "bad", label: "bad", types: ["x"], accessMode: "PUBLIC_NO_KEY",
        poll: async () => { throw new Error("upstream down"); }
    });
    const status = await service.start();
    assert.ok([SUBSYSTEM_STATE.READY, SUBSYSTEM_STATE.DEGRADED].includes(status.state));
    // Service tetap bisa melayani ask (return kosong), tidak melempar.
    const result = await service.ask({ types: ["x"] });
    assert.equal(result.observations.length, 0);
    assert.equal(result.providerStatuses[0].state, "unavailable");
    assert.equal(result.providerStatuses[0].failureReason, "upstream down");
    await service.shutdown();
});

test("EMBEDDING: tidak ada listener publik kedua — service tidak membuka port", () => {
    // Guard struktural: API Mata Dewa tidak memuat net.Server / listen.
    const src = require("fs").readFileSync(require.resolve("../../src/mataDewa/service.js"), "utf8");
    assert.equal(/createServer|\.listen\(/.test(src), false);
    const registrySrc = require("fs").readFileSync(require.resolve("../../src/mataDewa/registry/providerRegistry.js"), "utf8");
    assert.equal(/createServer|\.listen\(/.test(registrySrc), false);
});

test("EMBEDDING: registry menolak provider tanpa accessMode yang dikenal", () => {
    const registry = new ProviderRegistry({ clock });
    assert.throws(() => registry.registerProvider({ id: "x", types: [], accessMode: "BYPASS_ALL" }));
    assert.throws(() => registry.registerProvider({ id: "", accessMode: "PUBLIC_NO_KEY" }));
});

test("EMBEDDING: ingest observasi bounded (cache tidak tumbuh tanpa batas)", async () => {
    const service = new MataDewaService({ clock, maxObservations: 10 });
    await service.start();
    const flood = [];
    for (let i = 0; i < 50; i++) {
        flood.push({
            id: `obs_${i}`,
            type: "generic",
            geometry: { type: "point", lat: -6 + i * 0.1, lon: 106 },
            observedAt: clock.nowMs() - i * 1000,
            receivedAt: clock.nowMs() - i * 1000, // urut supaya buang yang lama
            confidence: 0.5
        });
    }
    service._ingestObservations(flood);
    assert.equal(service.observations.size, 10);
    await service.shutdown();
});
