"use strict";

/**
 * Mata Dewa visual capability executor — sisi Manager dari MD-001.
 *
 * Ketika Manager (komposisi kanonik yang mengautentikasi) mengeksekusi
 * capability `mata_dewa.mode.*`, actuator di sini yang menjalankan efeknya:
 *   1. set state UI mode di Mata Dewa service kanonik (in-process), lalu
 *   2. terbitkan perintah UI visual-only lewat batas perintah UI Damar
 *      (allowlist) → aliran event Damar yang SUDAH ADA → renderer.
 *
 * HUKUM:
 *   - VISUAL-ONLY: perintah ini tidak pernah mengotorisasi apa pun dan
 *     tidak menjalankan tooling. Kembali ke UI normal juga visual-only.
 *   - Tidak ada bypass Authority: akun Manager yang sah tetap harus lolos
 *     Lane 2 evaluate → Lane 3 execute sebelum actuator ini hidup.
 *   - MD-011/A4: service kanonik diselesaikan LAZY lewat `resolveService`
 *     (resolver leksikal milik komposisi kanonik — BUKAN DI seam publik).
 *     Service absen/tidak valid → FAIL CLOSED eksplisit
 *     (MATA_DEWA_SERVICE_UNAVAILABLE). Actuator TIDAK PERNAH menyentuh
 *     browser/window/render state secara langsung; ia HANYA memanggil
 *     service kanonik.
 *   - MD-011/A6: TIDAK ada publisher kedua. Publikasi `ui.mode.set` adalah
 *     milik MataDewaService (setUiMode → uiCommandPublisher → telemetry/SSE
 *     yang sudah ada). Pengiriman dilaporkan jujur lewat deliveryReason.
 *   - Pre-Lane4: komposisi produksi gagal tertutup pada autentikasi
 *     Manager (AUTHENTICATION_REQUIRED) — jalur ini terbukti E2E lewat
 *     komposisi produksi dengan autentikasi uji; produksi akan mengikuti
 *     begitu trust Lane 4 tersertifikasi terintegrasi.
 */

const { UI_MODE } = require("../service");
const { MATA_DEWA_SERVICE_UNAVAILABLE } = require("./visualModeWiring");

/**
 * Wire actuator MATA_DEWA UI ke registry actuator kanonik.
 *
 * @param {object} params
 * @param {{ register: Function }} params.actuatorRegistry  canonical Lane 3 registry
 * @param {string} params.capabilityId                      id capability kanonik
 * @param {string} params.capabilityIncarnationId           inkarnasi capability
 * @param {object} [params.service]                         MataDewaService langsung (komposisi uji)
 * @param {Function} [params.resolveService]                resolver leksikal produksi (lazy)
 *   Tepat satu dari service / resolveService wajib ada.
 * @returns {{ actuatorId: string }} binding actuator
 */
function registerMataDewaUiModeActuator({ actuatorRegistry, capabilityId, capabilityIncarnationId, service = null, resolveService = null }) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function") {
        throw new TypeError("actuatorRegistry.register wajib ada");
    }
    if (typeof capabilityId !== "string" || !capabilityId) {
        throw new TypeError("capabilityId wajib ada");
    }
    if (typeof capabilityIncarnationId !== "string" || !capabilityIncarnationId) {
        throw new TypeError("capabilityIncarnationId wajib ada");
    }
    const directService = service !== null && typeof service === "object" ? service : null;
    const hasResolver = typeof resolveService === "function";
    if (!directService && !hasResolver) {
        throw new TypeError("MATA_DEWA_WIRING_INVALID: butuh service (langsung) ATAU resolveService (lazy) — tepat satu");
    }

    const operation = capabilityId.endsWith(".deactivate") ? "deactivate" : "activate";
    const actuatorId = `act-matadewa-${operation}`;

    return actuatorRegistry.register({
        capabilityId,
        operations: [operation],
        capabilityIncarnationId,
        actuatorId,
        invoke: async ({ parameters } = {}) => {
            // MD-011/A4: resolusi LAZY di invoke time (hindari siklus urutan
            // komposisi); validasi service sebelum dipakai.
            let resolved = directService;
            if (!resolved && hasResolver) {
                try {
                    resolved = resolveService();
                }
                catch {
                    return { ok: false, reason: MATA_DEWA_SERVICE_UNAVAILABLE };
                }
            }
            if (!resolved || typeof resolved.setUiMode !== "function" ||
                typeof resolved.activateMode !== "function" ||
                typeof resolved.deactivateMode !== "function") {
                return { ok: false, reason: MATA_DEWA_SERVICE_UNAVAILABLE };
            }

            // Target dari operation actuator (bukan dari argumen yang dapat
            // dihilangkan): activate → mata-dewa, deactivate → normal.
            // parameters.mode boleh menegaskan target yang sama saja.
            const wireMode = operation === "deactivate" ? "normal" : "mata-dewa";
            if (parameters && parameters.mode !== undefined && parameters.mode !== wireMode) {
                return { ok: false, reason: "parameters.mode tidak cocok dengan operation" };
            }
            const result = wireMode === "normal"
                ? resolved.deactivateMode()
                : resolved.activateMode();
            if (!result.ok) {
                return { ok: false, reason: result.reason ?? "mode rejected" };
            }
            // Publikasi ui.mode.set terjadi DI DALAM setUiMode (publisher
            // milik service pada aliran telemetry Damar yang sudah ada);
            // hasil delivery dilaporkan jujur — tidak ada publisher kedua.
            return {
                ok: true,
                uiMode: result.uiMode,
                delivered: result.delivered === true,
                deliveryReason: result.deliveryReason ?? null
            };
        }
    });
}

module.exports = Object.freeze({
    registerMataDewaUiModeActuator,
    MATA_DEWA_SERVICE_UNAVAILABLE,
    UI_MODE
});
