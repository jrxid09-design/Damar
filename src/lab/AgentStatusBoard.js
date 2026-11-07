const activity = require("./ActivityLog");

/**
 * AgentStatusBoard — status hidup agent di dalam Lab (§9).
 *
 * State disusun dari EVENT NYATA (agent.started/completed/failed,
 * tool.started/…) — bukan simulasi (§42). TTL membuat agent kembali
 * IDLE bila tidak ada aktivitas (proses mati/daemon restart tidak
 * meninggalkan status bohong).
 */

const STATES = ["IDLE", "THINKING", "PLANNING", "WORKING", "WAITING_TOOL", "WAITING_AGENT", "WAITING_USER", "VERIFYING", "BLOCKED", "COMPLETED", "ERROR"];

/** Pemetaan event Lab → status agent. */
const EVENT_STATE = {
    "agent.started": "WORKING",
    "agent.completed": "COMPLETED",
    "agent.failed": "ERROR",
    "tool.started": "WAITING_TOOL",
    "tool.completed": "WORKING",
    "tool.failed": "ERROR",
    "mission.waiting_user": "WAITING_USER",
    "mission.verifying": "VERIFYING",
    "mission.blocked": "BLOCKED",
    "mission.started": "WORKING"
};

const TTL_MS = 5 * 60 * 1000;   // tanpa aktivitas 5 menit → IDLE

class AgentStatusBoard {

    constructor() {
        /** agentId → { status, missionId, task, since, updatedAt } */
        this.board = new Map();

        // Langganan event: dipasang malas (LabService.init) supaya
        // modul ini tidak memutar sikularitas saat require.
        this.wired = false;
    }

    init() {

        if (this.wired) return;
        this.wired = true;

        const telemetry = require("../services/telemetryService");

        telemetry.on("event", event => {

            const type = String(event?.type ?? "");

            if (!type.startsWith("lab:")) return;

            const kind = type.slice(4);
            const mapped = EVENT_STATE[kind];

            if (!mapped) return;

            const { agentId, missionId, payload } = event.payload ?? {};

            if (kind === "mission.waiting_user" || kind === "mission.verifying" || kind === "mission.blocked" || kind === "mission.started") {
                // event misi → semua agent misi tsb menunggu/verifikasi
                this.setBulkFromMission(event.payload, mapped);
                return;
            }

            if (agentId) {
                this.set(agentId, mapped, { missionId, task: payload?.task });
            }

        });

    }

    setBulkFromMission(evt, state) {
        // Hanya update agent yang SEDANG tercatat aktif di misi itu.
        for (const [agentId, info] of this.board.entries()) {
            if (info.missionId === evt.missionId && !["COMPLETED", "ERROR"].includes(info.status)) {
                this.set(agentId, state, { missionId: evt.missionId });
            }
        }
    }

    set(agentId, status, { missionId = null, task = null } = {}) {

        if (!STATES.includes(status)) return;

        this.board.set(agentId, {
            agentId,
            status,
            missionId,
            task,
            since: Date.now(),
            updatedAt: Date.now()
        });

    }

    /** Snapshot papan dengan peluruhan TTL. */
    snapshot() {

        const now = Date.now();
        const out = [];

        for (const [agentId, info] of this.board.entries()) {

            let status = info.status;

            // Status transien meluruh ke IDLE setelah TTL.
            const transient = ["WORKING", "WAITING_TOOL", "VERIFYING", "WAITING_AGENT", "THINKING", "PLANNING"];
            if (transient.includes(status) && now - info.updatedAt > TTL_MS) {
                status = "IDLE";
            }

            out.push({ ...info, status, ageMs: now - info.updatedAt });

        }

        return out.sort((a, b) => a.agentId.localeCompare(b.agentId));

    }

    get(agentId) {
        return this.snapshot().find(s => s.agentId === agentId) ?? { agentId, status: "IDLE" };
    }

    states() { return STATES; }

}

module.exports = new AgentStatusBoard();
