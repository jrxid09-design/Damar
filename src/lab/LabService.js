/**
 * LabService — SATU PINTU Aether Lab (§43 deliverable).
 *
 * Facade di atas modul-modul lab; controller & AI tool hanya melihat
 * service ini. Eksekusi tetap mendelegasikan ke infrastruktur yang
 * sudah ada (orchestrator/agentHub/agentTools/opencode/memory) —
 * tidak ada runtime paralel (§42).
 */

const projects = require("./ProjectEngine");
const missions = require("./MissionEngine");
const activity = require("./ActivityLog");
const artifacts = require("./ArtifactRegistry");
const decisions = require("./DecisionLog");
const experiments = require("./ExperimentLab");
const testChamber = require("./TestChamber");
const instruments = require("./InstrumentCatalog");
const memory = require("./MemoryBridge");
const snapshots = require("./TimeMachine");
const statusBoard = require("./AgentStatusBoard");

/** Dipanggil saat daemon start: pasang langganan papan status. */
function init() {
    statusBoard.init();
}

module.exports = {
    init,
    projects, missions, activity, artifacts, decisions,
    experiments, testChamber, instruments, memory, snapshots,
    statusBoard
};
