"use strict";

/**
 * Damar UI Command Boundary — VISUAL-ONLY command delivery ke renderer.
 *
 * MD-001 repair: Manager/capability-originated UI mode changes must reach
 * the EXISTING renderer through a canonical Damar-owned seam.
 *
 * LAWS:
 *   - VISUAL-ONLY UI COMMAND ≠ CONSEQUENTIAL ACTION. Mode navigation and
 *     view framing are presentation concerns; they never authorize anything
 *     and never execute tooling. Consequential operations keep flowing
 *     through the canonical Action Fabric (Manager → Authority → Actuation
 *     → Verification).
 *   - Allowlisted vocabulary ONLY. No arbitrary JavaScript, no eval, no
 *     generic "run code" surface. Unknown commands are rejected here.
 *   - Delivery reuses the EXISTING Damar telemetry event stream
 *     (telemetryService.publish → SSE /api/v1/console/events → renderer
 *     onEvent). NO second WebSocket, NO second HTTP server, NO second
 *     renderer runtime, NO model-to-window shortcut.
 *   - The renderer applies commands from a mirror allowlist; it never
 *     receives executable payloads.
 *
 * POST-LANE4 NOTE: Manager-originated activation via the canonical action
 * fabric fails closed at Manager authentication until certified Lane 4
 * trust lands. This boundary is the delivery seam; it grants no authority.
 */

/** Command vocabulary (allowlist). Values are stable wire identifiers. */
const UI_COMMANDS = Object.freeze({
    /** Set the top-level UI mode of the existing Console application. */
    UI_MODE_SET: "ui.mode.set"
});

/**
 * Arguments schema per command. Extra/unknown args are rejected.
 * Only visual-only commands may appear here; consequential capabilities
 * are registered in the canonical Capability Registry instead.
 */
const COMMAND_ARG_SCHEMA = Object.freeze({
    [UI_COMMANDS.UI_MODE_SET]: Object.freeze({
        mode: Object.freeze({
            validate: (value) => value === "mata-dewa" || value === "normal",
            reason: "mode must be 'mata-dewa' or 'normal'"
        })
    })
});

const MAX_ARGS_KEYS = 4;
const MAX_PAYLOAD_BYTES = 512;

function boundedString(value, max) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
}

/**
 * Validasi perintah UI terhadap allowlist.
 * @returns {{ ok:true, command:string, args:object } | { ok:false, reason:string }}
 */
function validateUiCommand(command, args = {}) {
    const name = boundedString(command, 64);
    if (!name || !Object.values(UI_COMMANDS).includes(name)) {
        return { ok: false, reason: `perintah UI tidak dikenal: ${String(name ?? "")}` };
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, reason: "args harus berupa object" };
    }
    const keys = Object.keys(args);
    if (keys.length > MAX_ARGS_KEYS) {
        return { ok: false, reason: `args melebihi ${MAX_ARGS_KEYS} kunci` };
    }
    const schema = COMMAND_ARG_SCHEMA[name];
    const clean = {};
    for (const key of keys) {
        const rule = schema?.[key];
        if (!rule) {
            return { ok: false, reason: `argumen tidak dikenal: ${key}` };
        }
        if (!rule.validate(args[key])) {
            return { ok: false, reason: rule.reason };
        }
        clean[key] = args[key];
    }
    // Semua argumen skema wajib ada.
    for (const required of Object.keys(schema ?? {})) {
        if (!(required in clean)) {
            return { ok: false, reason: `argumen wajib hilang: ${required}` };
        }
    }
    return { ok: true, command: name, args: clean };
}

/**
 * Buat publisher UI command terikat pada satu event emitter Damar.
 * @param {{ publish: (type:string, payload:object)=>object }} telemetry
 *   Damar telemetryService (sumber SSE kanonik yang sudah ada).
 */
function createUiCommandPublisher(telemetry) {
    if (!telemetry || typeof telemetry.publish !== "function") {
        throw new TypeError("createUiCommandPublisher butuh telemetry.publish");
    }
    let sequence = 0;
    /**
     * Terbitkan perintah UI visual-only. Tidak melempar — kegagalan
     * pengiriman tidak boleh menjatuhkan pemanggil (capability/actuator).
     * @returns {{ ok:boolean, reason?:string, eventId?:number }}
     */
    function publishUiCommand(command, args = {}) {
        const validated = validateUiCommand(command, args);
        if (!validated.ok) return { ok: false, reason: validated.reason };
        sequence += 1;
        try {
            const event = telemetry.publish("damar:ui-command", {
                command: validated.command,
                args: validated.args,
                seq: sequence,
                // Marking: visual-only. Renderer TIDAK boleh memberi perlakuan
                // otoritatif apa pun pada event ini.
                visualOnly: true
            });
            return { ok: true, eventId: event?.id ?? null };
        }
        catch (error) {
            return { ok: false, reason: error?.message ?? "publish failed" };
        }
    }
    return Object.freeze({ publishUiCommand, validate: validateUiCommand });
}

module.exports = Object.freeze({
    UI_COMMANDS,
    COMMAND_ARG_SCHEMA,
    validateUiCommand,
    createUiCommandPublisher,
    MAX_PAYLOAD_BYTES
});
