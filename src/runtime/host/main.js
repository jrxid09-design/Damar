"use strict";

// Alias env lama AETHER_* -> DAMAR_* (deprecated; kanonik = DAMAR_*).
require("../../config/envCompat");

/**
 * DamarRuntime entry — host runtime berdiri sendiri TANPA Console/Electron.
 *
 * Menuju masa depan DamarRuntime.exe: proses ini cukup dipanggil langsung
 * (node src/runtime/host/main.js) dan Damar tetap hidup di DORMANT meski
 * Console tertutup. Observatory/Console kelak menjadi KLIEN status runtime,
 * bukan prasyaratnya. Belum ada packaging.
 */

const { createRuntimeHost } = require("./runtimeHost");
const { createChannelBridge } = require("./channelBridge");
const { createTrayControllerForHost } = require("./ports/trayPort");
const { createHotkeyPort, DEFAULT_SUMMON_COMBO } = require("./ports/hotkeyPort");

async function main() {
    const host = await createRuntimeHost({
        coreOptions: {
            wave1: { damarSelfDir: process.env.DAMAR_HOST_SELF_DIR ?? null }
        }
    });

    // Bridge transport nyata (fail-soft; telemetry emitter opsional).
    let bridge = null;
    try {
        bridge = createChannelBridge({ bus: host.core.bus, channels: ["telegram"] });
        const telemetry = require("../../../services/telemetryService");
        bridge.attachEmitter(telemetry);
    } catch { /* host tetap jalan tanpa bridge */ }

    // Fondasi hotkey + tray: semantik penuh, UI menyusul sebagai adapter.
    const hotkeys = createHotkeyPort({
        onCommand: ({ command }) => {
            if (command === "summon") return host.summon({ source: "hotkey" });
            if (command === "dismiss") return host.dismiss({ source: "hotkey" });
            return { ok: false, code: "COMMAND_UNKNOWN" };
        }
    });
    hotkeys.register({ combo: process.env.DAMAR_SUMMON_HOTKEY ?? DEFAULT_SUMMON_COMBO });

    const tray = createTrayControllerForHost(host);

    console.log(`[damar-runtime-host] v${host.version} phase=${host.phase} ` +
        `presence=${host.core.presence.lifecycleState} pid=${process.pid}`);

    const shutdown = (signal) => {
        console.log(`[damar-runtime-host] ${signal} → graceful shutdown`);
        try { hotkeys.close(); } catch { /* idempoten */ }
        try { if (bridge) bridge.detach(); } catch { /* idempoten */ }
        host.requestShutdown({ reason: `signal:${signal}` });
        process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    return { host, hotkeys, tray, bridge };
}

if (require.main === module) {
    main().catch((error) => {
        console.error("[damar-runtime-host] boot gagal:", error.message);
        process.exit(1);
    });
}

module.exports = { main };
