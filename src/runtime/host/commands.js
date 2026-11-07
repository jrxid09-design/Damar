"use strict";

/**
 * HOST SEMANTIC COMMANDS — kosakata perintah semantik Runtime Host.
 *
 * HUKUM (load-bearing):
 *   - Perintah di sini hanya menggerakkan LIFECYCLE (summon/dismiss/
 *     status/shutdown-request). TIDAK ada yang memberi izin, autentikasi,
 *     atau mengaktifkan aktuator.
 *   - Normalisasi murni: payload mentah dari transport mana pun dipetakan
 *     menjadi record kanonik ATAU ditolak. Tidak ada eksekusi di sini.
 */

const HOST_COMMANDS = Object.freeze({
    SUMMON: "summon",
    DISMISS: "dismiss",
    STATUS: "status",
    SHUTDOWN: "shutdown"
});

const COMMAND_SET = new Set(Object.values(HOST_COMMANDS));

const MAX_TEXT = 512;

function bounded(value, max = MAX_TEXT) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, max);
}

/**
 * Normalisasi payload COMMAND menjadi record semantik.
 * Menerima: string ("summon") atau { command, reason?, source?, requestId? }.
 * Mengembalikan { ok:true, command, reason, source, requestId }
 * atau      { ok:false, code }.
 */
function normalizeHostCommand(payload) {
    let raw = payload;
    if (typeof raw === "string") raw = { command: raw };
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, code: "COMMAND_INVALID" };
    }

    const command = bounded(raw.command, 32)?.toLowerCase();
    if (!command || !COMMAND_SET.has(command)) {
        return { ok: false, code: "COMMAND_UNKNOWN" };
    }

    return Object.freeze({
        ok: true,
        command,
        reason: bounded(raw.reason) ?? null,
        source: bounded(raw.source, 64) ?? "unknown",
        requestId: bounded(raw.requestId, 128)
    });
}

module.exports = Object.freeze({
    HOST_COMMANDS,
    normalizeHostCommand
});
