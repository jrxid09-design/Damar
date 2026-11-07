import { damarState } from "./damarState.js";

/**
 * Agent Bus — jembatan aktivitas multi-agent → visualisasi.
 *
 * Menerjemahkan event telemetry `orchestrator:*` (yang mengalir lewat
 * SSE /events ke Console) menjadi keadaan yang bisa digambar:
 *
 *   planning        → mood "thinking"  (orb utama violet, menyusun rencana)
 *   step:start      → engage(agent)    (orb agent mendekat & menyalurkan energi)
 *                     mood "executing"
 *   step:done       → release(agent, ok) (orb agent pulang + flash hasil)
 *   final           → mood "success" | "error" (semua langkah ok?)
 *                     lalu kembali "idle" setelah sempat dipamerkan.
 *
 * Mood TIDAK menimpa sesi suara: saat Damar sedang mendengar atau
 * berbicara, perubahan mood ditahan supaya percakapan tetap koheren.
 */

const listeners = new Set();

/** id agent → jumlah langkah berjalan (ref-count, antisipasi paralel). */
const engaged = new Map();

let moodTimer = null;

function emit(evt) {
    for (const fn of listeners) fn(evt);
}

const VOICE_STATES = ["listening", "speaking"];

function setMood(m) {

    // Jangan menimpa sesi suara yang sedang berlangsung.
    if (VOICE_STATES.includes(damarState.state)) return;

    damarState.set(m);

    clearTimeout(moodTimer);

    // Mood hasil (sukses/galat) dipajang sejenak, lalu bernapas normal.
    if (m === "success" || m === "error") {
        moodTimer = setTimeout(() => {
            if (["success", "error"].includes(damarState.state)) {
                damarState.set("idle");
            }
        }, 2800);
    }

}

export const agentBus = {

    /** Daftar id agent yang sedang bekerja. */
    get engagedIds() {
        return [...engaged.entries()].filter(([, n]) => n > 0).map(([id]) => id);
    },

    subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    /**
     * Terima event telemetry mentah dari aliran SSE Console.
     * @param {string} type   mis. "orchestrator:step:start"
     * @param {object} payload
     */
    ingest(type, payload = {}) {

        const kind = String(type ?? "").startsWith("orchestrator:")
            ? type.slice(13)
            : type;

        switch (kind) {

            case "planning": {
                setMood("thinking");
                emit({ t: "mood", m: "thinking" });
                break;
            }

            case "step:start": {
                const id = payload?.step?.agent;
                if (!id) break;
                engaged.set(id, (engaged.get(id) ?? 0) + 1);
                setMood("executing");
                emit({ t: "engage", id });
                break;
            }

            case "step:done": {
                const id = payload?.step?.agent;
                if (!id) break;
                const n = (engaged.get(id) ?? 1) - 1;
                if (n <= 0) engaged.delete(id);
                else engaged.set(id, n);
                emit({ t: "release", id, ok: payload?.ok !== false });
                break;
            }

            case "final": {
                const steps = Array.isArray(payload?.steps) ? payload.steps : [];
                const allOk = steps.length > 0 && steps.every(s => s?.ok !== false);
                setMood(allOk ? "success" : "error");
                emit({ t: "mood", m: allOk ? "success" : "error" });
                break;
            }

        }

    }

};
