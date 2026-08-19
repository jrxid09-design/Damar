/**
 * AutonomyService — facade runtime otonom Aether (§53).
 *
 * Dipanggil oleh controller, AI tools, dan worker latar. Semua modul
 * memakai infrastruktur yang SUDAH ADA sebagai tulang punggung:
 * ToolRegistry/toolGuard (eksekusi+keselamatan), ToolForge (implementasi
 * skill), aiRuntimeService (model & fallback), agentHub (spesialis),
 * memory (belajar), Lab MissionEngine (misi proyek).
 */

const toolBus = require("./ToolBus");
const capabilities = require("./CapabilityRegistry");
const skillFactory = require("./SkillFactory");
const goals = require("./GoalEngine");
const healing = require("./SelfHealingEngine");
const modelRouter = require("./ModelRouter");
const checkpoints = require("./CheckpointSystem");
const environment = require("./EnvironmentModel");

let booted = false;

/** Dipanggil saat daemon start. */
async function init() {

    if (booted) return;
    booted = true;

    // Sinkron peta kapabilitas awal (non-blokir).
    capabilities.sync().catch(() => { /* daemon tetap hidup */ });

    // Pantau lingkungan (event berkala untuk strategi §42).
    environment.startWatch();

    // Worker housekeeping: kedaluwarsakan skill sementara (§5).
    setInterval(() => {
        skillFactory.expireTemporary().catch(() => { /* opsional */ });
    }, 60 * 60 * 1000).unref?.();

}

module.exports = {
    init,
    toolBus, capabilities, skillFactory, goals,
    healing, modelRouter, checkpoints, environment
};
