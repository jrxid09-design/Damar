"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRuntimeHost } = require("../../src/runtime/host/runtimeHost");
const { createHotkeyPort, DEFAULT_SUMMON_COMBO } = require("../../src/runtime/host/ports/hotkeyPort");
const {
    createTrayController,
    createTrayControllerForHost
} = require("../../src/runtime/host/ports/trayPort");

// ----------------------------------------------------------------- tests

test("HOTKEY: dispatch memicu perintah semantik summon via host", async () => {
    const host = await createRuntimeHost({ coreOptions: {} });
    try {
        const dispatched = [];
        const port = createHotkeyPort({
            onCommand: ({ command }) => {
                dispatched.push(command);
                return host.summon({ source: "hotkey" });
            }
        });
        const reg = port.register({ combo: DEFAULT_SUMMON_COMBO });
        assert.equal(reg.ok, true);

        const hit = port.dispatch(DEFAULT_SUMMON_COMBO);
        assert.equal(hit.ok, true);
        assert.deepEqual(dispatched, ["summon"]);
        assert.equal(host.health().presenceState, "AWAKE",
            "hotkey summon menggerakkan presence ke AWAKE");

        assert.equal(port.dispatch("Ctrl+Alt+TidakAda").ok, false);

        port.close();
        assert.equal(port.dispatch(DEFAULT_SUMMON_COMBO).ok, false);
    } finally {
        host.shutdown("test-end");
    }
});

test("HOTKEY: re-register mengganti binding; unregister bersih", () => {
    const port = createHotkeyPort({ onCommand: () => ({ ok: true }) });
    assert.equal(port.register({ combo: "X" }).replaced, false);
    assert.equal(port.register({ combo: "X", command: "dismiss" }).replaced, true);
    assert.equal(port.unregister("X").ok, true);
    assert.equal(port.unregister("X").ok, false);
    assert.equal(port.snapshot().bindings.length, 0);
});

test("TRAY: aksi tray mendelegasikan semantik host tanpa UI", async () => {
    const host = await createRuntimeHost({ coreOptions: {} });
    try {
        const tray = createTrayControllerForHost(host);

        const status = tray.getStatus();
        assert.equal(status.host.phase, "READY");

        tray.onSummon({});
        assert.equal(host.health().presenceState, "AWAKE");

        tray.onDismiss({});
        assert.equal(host.health().presenceState, "DORMANT",
            "tray dismiss hanya DORMANT, proses tetap hidup");
        assert.equal(host.phase, "READY");
    } finally {
        host.shutdown("test-end");
    }
});

test("TRAY: shutdown runtime adalah satu-satunya jalan proses mati", async () => {
    const host = await createRuntimeHost({ coreOptions: {} });
    const tray = createTrayControllerForHost(host);
    tray.onShutdownRuntime({ source: "menu" });
    assert.equal(host.phase, "TERMINATED");
});

test("TRAY: openObservatory tanpa launcher → jujur tidak diluncurkan", async () => {
    const tray = createTrayController({
        summon: () => ({}), dismiss: () => ({}),
        status: () => ({}), shutdown: () => ({})
    });
    const r = tray.onOpenObservatory();
    assert.equal(r.launched, false);
    assert.equal(r.reason, "OBSERVATORY_LAUNCHER_NOT_BOUND");
});

test("TRAY: openObservatory dengan launcher injeksi mendelegasikan eksternal", () => {
    let launched = 0;
    const tray = createTrayController({
        summon: () => ({}), dismiss: () => ({}),
        status: () => ({}), shutdown: () => ({}),
        openObservatory: () => { launched += 1; return { pid: 123 }; }
    });
    const r = tray.onOpenObservatory();
    assert.equal(r.launched, true);
    assert.equal(launched, 1);
});

test("TRAY: konstruksi tanpa dependensi wajib gagal tertutup", () => {
    assert.throws(() => createTrayController({}), /TRAY_CONTROLLER_SUMMON_INVALID/);
});
