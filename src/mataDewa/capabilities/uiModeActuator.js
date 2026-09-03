"use strict";

/**
 * Mata Dewa visual capability executor — sisi Manager dari MD-001.
 *
 * Ketika Manager (komposisi kanonik yang mengautentikasi) mengeksekusi
 * capability `mata_dewa.mode.*`, actuator di sini yang menjalankan efeknya:
 *   1. set state UI mode di Mata Dewa service (in-process), lalu
 *   2. terbitkan perintah UI visual-only lewat batas perintah UI Damar
 *      (allowlist) → aliran event Damar yang SUDAH ADA → renderer.
 *
 * HUKUM:
 *   - VISUAL-ONLY: perintah ini tidak pernah mengotorisasi apa pun dan
 *     tidak menjalankan tooling. Kembali ke UI normal juga visual-only.
 *   - Tidak ada bypass Authority: akun Manager yang sah tetap harus lolos
 *     Lane 2 evaluate → Lane 3 execute sebelum actuator ini hidup.
 *   - Pre-Lane4: komposisi produksi gagal tertutup pada autentikasi
 *     Manager (AUTHENTICATION_REQUIRED) — jalur ini terbukti E2E lewat
 *     komposisi produksi dengan autentikasi uji; produksi akan mengikuti
 *     begitu trust Lane 4 tersertifikasi terintegrasi.
 */

const { UI_MODE } = require("../service");
const { createUiCommandPublisher, UI_COMMANDS } = require("../uiCommands");

/**
 * Wire actuator MATA_DEWA UI ke sebuah registry actuator (komposisi uji /
 * komposisi produksi masa depan yang memegang registrar).
 *
 * @param {object} params
 * @param {{ register: Function }} params.actuatorRegistry  registry Lane 3
 * @param {string} params.capabilityId                      id capability kanonik
 * @param {string} params.capabilityIncarnationId           inkarnasi capability
 * @param {object} params.service                           MataDewaService
 * @param {object} params.telemetry                         telemetryService Damar
 * @returns {{ actuatorId: string }} binding actuator
 */
function registerMataDewaUiModeActuator({ actuatorRegistry, capabilityId, capabilityIncarnationId, service, telemetry }) {
    if (!actuatorRegistry || typeof actuatorRegistry.register !== "function") {
        throw new TypeError("actuatorRegistry.register wajib ada");
    }
    if (typeof capabilityId !== "string" || !capabilityId) {
        throw new TypeError("capabilityId wajib ada");
    }
    if (typeof capabilityIncarnationId !== "string" || !capabilityIncarnationId) {
        throw new TypeError("capabilityIncarnationId wajib ada");
    }
    if (!service || typeof service.setUiMode !== "function") {
        throw new TypeError("service.setUiMode wajib ada");
    }

    const publisher = createUiCommandPublisher(telemetry);
    const operation = capabilityId.endsWith(".deactivate") ? "deactivate" : "activate";
    const actuatorId = `act-matadewa-${operation}`;

    return actuatorRegistry.register({
        capabilityId,
        operations: [operation],
        capabilityIncarnationId,
        actuatorId,
        invoke: async ({ parameters } = {}) => {
            // Target dari operation actuator (bukan dari argumen yang dapat
            // dihilangkan): activate → mata-dewa, deactivate → normal.
            // parameters.mode boleh menegaskan target yang sama saja.
            const wireMode = operation === "deactivate" ? "normal" : "mata-dewa";
            if (parameters && parameters.mode !== undefined && parameters.mode !== wireMode) {
                return { ok: false, reason: "parameters.mode tidak cocok dengan operation" };
            }
            const result = wireMode === "normal"
                ? service.deactivateMode()
                : service.activateMode();
            if (!result.ok) {
                return { ok: false, reason: result.reason ?? "mode rejected" };
            }
            // Delivery sudah diterbitkan di dalam setUiMode bila publisher
            // terpasang; laporkan hasil delivery secara jujur.
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
    UI_COMMANDS,
    UI_MODE
});
