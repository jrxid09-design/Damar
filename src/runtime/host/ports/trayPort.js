"use strict";

/**
 * TRAY PORT — kontrak system tray (fondasi).
 *
 * Tray secara konseptual mengekspos:
 *   - Aether status
 *   - Summon
 *   - Dismiss
 *   - Open Observatory
 *   - Shutdown Runtime
 *
 * HUKUM:
 *   - Semantik runtime TIDAK bergantung pada UI. Tray adalah pemanggil
 *     perintah semantik; kegagalan/ketiadaan UI tidak mengubah lifecycle.
 *   - Open Observatory adalah urusan UI eksternal: host tidak pernah
 *     membutuhkannya dan hanya mendelegasikan ke launcher yang disuntik.
 *   - Shutdown Runtime lewat tray = requestShutdown eksplisit (satu-satunya
 *     jalan proses mati). Dismiss != Shutdown.
 */

const { HOST_COMMANDS } = require("../commands");

/**
 * createTrayController({ summon, dismiss, status, shutdown, openObservatory? })
 * Semua aksi disuntik (biasanya delegasi tipis ke RuntimeHost). Tanpa UI.
 */
function createTrayController({
    summon,
    dismiss,
    status,
    shutdown,
    openObservatory = null
} = {}) {
    for (const [name, fn] of [["summon", summon], ["dismiss", dismiss], ["status", status], ["shutdown", shutdown]]) {
        if (typeof fn !== "function") {
            throw new TypeError(`TRAY_CONTROLLER_${name.toUpperCase()}_INVALID`);
        }
    }
    if (openObservatory !== null && typeof openObservatory !== "function") {
        throw new TypeError("TRAY_CONTROLLER_OPEN_OBSERVATORY_INVALID");
    }

    function getStatus() {
        return status();
    }

    function onSummon({ source = "tray" } = {}) {
        return summon({ source });
    }

    function onDismiss({ source = "tray" } = {}) {
        return dismiss({ source });
    }

    function onShutdownRuntime({ source = "tray" } = {}) {
        return shutdown(`tray:${source}`);
    }

    /** Eksternal & opsional. Host tidak pernah mewajibkan Observatory. */
    function onOpenObservatory() {
        if (!openObservatory) {
            return { launched: false, reason: "OBSERVATORY_LAUNCHER_NOT_BOUND" };
        }
        try {
            return { launched: true, ...openObservatory() };
        } catch (error) {
            return { launched: false, reason: error?.message?.slice(0, 120) ?? "LAUNCH_FAULT" };
        }
    }

    return Object.freeze({
        getStatus,
        onSummon,
        onDismiss,
        onOpenObservatory,
        onShutdownRuntime
    });
}

/** Delegasi tipis dari TrayController ke RuntimeHost. */
function createTrayControllerForHost(host, { observatoryLauncher = null } = {}) {
    if (!host || typeof host.summon !== "function") {
        throw new TypeError("TRAY_HOST_INVALID");
    }
    return createTrayController({
        summon: ({ source }) => host.summon({ source }),
        dismiss: ({ source }) => host.dismiss({ source }),
        status: () => host.status(),
        shutdown: (reason) => host.requestShutdown({ reason }),
        openObservatory: observatoryLauncher
    });
}

module.exports = Object.freeze({
    createTrayController,
    createTrayControllerForHost,
    TRAY_COMMANDS: HOST_COMMANDS
});
