"use strict";

/**
 * HOTKEY PORT — kontrak hotkey summon global (fondasi).
 *
 * HUKUM:
 *   - Runtime semantics TIDAK bergantung pada UI. Port ini adalah kontrak;
 *     implementasi Windows nyata (RegisterHotKey) menyusul sebagai adapter.
 *   - Hotkey hanya memicu perintah semantik (summon/dismiss/status).
 *     Hotkey != Permission, != Authority, != Actuation.
 */

const { HOST_COMMANDS } = require("../commands");

const DEFAULT_SUMMON_COMBO = "Ctrl+Alt+A";

/**
 * createHotkeyPort({ onCommand }) — port tanpa OS. Pemanggil mendaftarkan
 * binding; environment nyata (Windows hook / simulator test) memanggil
 * dispatch(combo). Tidak ada timer, tidak akses OS.
 */
function createHotkeyPort({ onCommand } = {}) {
    if (onCommand !== undefined && typeof onCommand !== "function") {
        throw new TypeError("HOTKEY_PORT_ON_COMMAND_INVALID");
    }
    const bindings = new Map();
    let closed = false;

    function register({ combo = DEFAULT_SUMMON_COMBO, command = HOST_COMMANDS.SUMMON, source = "hotkey" } = {}) {
        if (closed) return { ok: false, code: "HOTKEY_PORT_CLOSED" };
        if (typeof combo !== "string" || !combo.trim()) {
            return { ok: false, code: "HOTKEY_COMBO_INVALID" };
        }
        const key = combo.trim();
        const previous = bindings.get(key);
        bindings.set(key, Object.freeze({
            combo: key,
            command,
            source,
            handle: Symbol("hotkey-binding")
        }));
        return { ok: true, combo: key, replaced: Boolean(previous) };
    }

    function unregister(combo) {
        return bindings.delete(typeof combo === "string" ? combo.trim() : "")
            ? { ok: true } : { ok: false, code: "HOTKEY_BINDING_NOT_FOUND" };
    }

    /** Dipanggil oleh backend OS/simulator saat kombinasi ditekan. */
    function dispatch(combo) {
        if (closed) return { ok: false, code: "HOTKEY_PORT_CLOSED" };
        const binding = bindings.get(String(combo).trim());
        if (!binding) return { ok: false, code: "HOTKEY_NOT_BOUND" };
        if (!onCommand) return { ok: false, code: "HOTKEY_NO_HANDLER" };
        return {
            ok: true,
            dispatched: onCommand({
                command: binding.command,
                source: `hotkey:${binding.combo}`
            })
        };
    }

    function close() {
        closed = true;
        bindings.clear();
        return { ok: true };
    }

    function snapshot() {
        return Object.freeze({
            closed,
            bindings: Object.freeze([...bindings.values()].map((b) => ({
                combo: b.combo, command: b.command, source: b.source
            })))
        });
    }

    return Object.freeze({ register, unregister, dispatch, close, snapshot });
}

module.exports = Object.freeze({
    createHotkeyPort,
    DEFAULT_SUMMON_COMBO
});
