/**
 * Watchdog — Aether merawat dirinya sendiri.
 *
 * Tiap 60 detik ia memeriksa tanda-tanda sakit:
 *   - voice runtime yang berulang kali error → di-restart sendiri
 *   - klien MCP yang mati → di-restart + re-bridge tool
 *   - event-loop lag ekstrem → peringatan keras (bisa jadi host kehabisan CPU)
 *
 * Setiap aksi penyembuhan dicatat (telemetry + data/watchdog.json) —
 * otonomi tanpa jejak sama dengan menyembunyikan kegagalan.
 */

const fs = require("node:fs");
const path = require("node:path");

const telemetry = require("../services/telemetryService");

const INTERVAL_MS = 60 * 1000;

/** Fungsi murni: keadaan sebelum/ sesudah → daftar aksi (testable). */
function decide(prev, now) {

    const actions = [];

    if ((now.voiceFailStreak ?? 0) >= 3 && (prev?.voiceFailStreak ?? 0) < 3) {
        actions.push("restart_voice");
    }

    if ((now.mcpOffline ?? 0) > (prev?.mcpOffline ?? 0)) {
        actions.push("restart_mcp");
    }

    if ((now.loopLagMs ?? 0) > 2000) {
        actions.push("warn_lag");
    }

    return actions;

}

class Watchdog {

    constructor({ intervalMs = INTERVAL_MS } = {}) {

        this.intervalMs = intervalMs;
        this.timer = null;
        this.running = false;

        this.prev = {};
        this.voiceFailStreak = 0;
        this.lastVoiceError = null;

        // N2-FINAL: penghitung kegagalan remediasi langsung per aksi —
        // pemicu eskalasi otonom lewat batas internal (internal:true).
        this.remediationFailures = {};

        this.onLog = (entry) => {
            // Hitung streak kegagalan voice dari lognya.
            if (/^\[voice\]/.test(String(entry?.message ?? "")) &&
                entry.level === "warn") {
                this.voiceFailStreak++;
                this.lastVoiceError = entry.message;
            }
            else if (/^\[voice\]/.test(String(entry?.message ?? "")) &&
                     entry.level === "info") {
                this.voiceFailStreak = 0;
            }
        };

    }

    file() {
        return process.env.AETHER_WATCHDOG_FILE ||
            path.join(process.cwd(), "data", "watchdog.json");
    }

    start() {

        if (this.running) return this;
        this.running = true;

        telemetry.on("log", this.onLog);

        this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
        this.timer.unref?.();

        telemetry.publish("watchdog:start", {});

        return this;

    }

    stop() {
        this.running = false;
        clearInterval(this.timer);
        telemetry.off("log", this.onLog);
        return this;
    }

    /** Ukur lag event-loop kasar (drift setTimeout 100ms). */
    measureLag() {
        return new Promise(resolve => {
            const start = Date.now();
            setTimeout(() => resolve(Date.now() - start - 100), 100);
        });
    }

    async tick() {

        const lagMs = await this.measureLag();

        let mcpOffline = 0;
        try {
            const mgr = require("../mcp/mcpClientManager");
            for (const c of mgr.clients.values()) {
                if (!c._ready) mcpOffline++;
            }
        }
        catch { /* manager belum termuat */ }

        const nowState = {
            voiceFailStreak: this.voiceFailStreak,
            mcpOffline,
            loopLagMs: lagMs
        };

        const actions = decide(this.prev, nowState);

        for (const action of actions) {

            try {

                if (action === "restart_voice") {
                    const rt = require("../voice").runtime;
                    await rt.stop();
                    await rt.start();
                    telemetry.warn("[watchdog] voice runtime direstart otomatis.");
                }

                if (action === "restart_mcp") {
                    const mgr = require("../mcp/mcpClientManager");
                    await mgr.restart();
                    telemetry.warn("[watchdog] klien MCP direstart otomatis.");
                }

                if (action === "warn_lag") {
                    telemetry.error(
                        `[watchdog] event-loop lag ${lagMs}ms — host kekurangan CPU?`
                    );
                }

                this.journal(action, nowState);

                this.remediationFailures[action] = 0;

            }
            catch (error) {
                telemetry.warn(`[watchdog] aksi ${action} gagal: ${error.message}`);

                // N2-FINAL — BATAS INTERNAL OTONOM (lihat escalateAutonomously).
                this.remediationFailures[action] =
                    (this.remediationFailures[action] ?? 0) + 1;

                if (this.remediationFailures[action] >= 2) {
                    await this.escalateAutonomously(action, error);
                }
            }

        }

        this.prev = nowState;

        return actions;

    }

    /**
     * C-F — HIMPUNAN KAPABILITAS PEMULIHAN WATCHDOG (eksplisit & tertutup).
     *
     * Eskalasi otonom TIDAK menerima universe system penuh. Observasi
     * yang bisa dipengaruhi penyerang (log, status MCP, pesan error)
     * tidak boleh membuka terminal, filesystem-tulis, skill factory,
     * Kali tooling, atau pesan keluar. Di luar set ini → DENY di
     * gerbang eksekusi (Authorization.assertExecution), apa pun peran.
     *
     * C-CANONICAL: anggota ditulis sebagai ID KAPABILITAS KANONIK
     * (bentuk registry inti) — BUKAN nama model-facing dan BUKAN tail
     * ambigu. Authorization.capSetWithin membandingkan kanonik-ke-
     * kanonik, jadi 'evil__system_health' TIDAK masuk grant hanya
     * karena ruas akhirnya menabrak.
     */
    static RECOVERY_CAPABILITIES = Object.freeze([
        "memory_recall",                 // native
        "system.time.currentTime",       // plugin system.time (kanonik)
        "aetherSkills.system_health",    // plugin aetherSkills (kanonik)
        "aetherSkills.agents_status",    // plugin aetherSkills (kanonik)
        "tool_search"                    // native meta-discovery (terbatas set)
    ]);

    /**
     * N2-FINAL — BATAS INTERNAL OTONOM.
     *
     * Watchdog adalah timer in-process yang di-start server.js: tidak
     * ada manusia/model/request di belakangnya. Inilah SATU-satunya
     * jenis batas yang sah meminta delegasi tanpa inisiator
     * (internal:true) — dan hanya setelah remediasi langsung gagal
     * berulang. Provenance + capability set terbatas mengalir ke
     * seluruh delegasi.
     */
    async escalateAutonomously(action, error, failures = 2) {

        try {
            const healing = require("./SelfHealingEngine");
            await healing.recover({
                tool: "agent:aether",
                action:
                    `Layanan "${action}" gagal dipulihkan langsung ` +
                    `${failures}× berturut-turut. ` +
                    "Diagnosis akar masalah dengan diagnostics terbatas, " +
                    "lakukan pemulihan nyata bila kapabilitasnya tersedia, " +
                    "dan laporkan HASIL (bukan niat). Jangan menyentuh " +
                    "kapabilitas di luar lingkup pemulihan layanan ini.",
                error,
                goalId: null,
                requirement: `pemulihan otonom ${action}`,
                // ← satu-satunya jalur sah menuju grant system:
                internal: true,
                // ← dan SELALU terkunci pada himpunan pemulihan:
                capabilitySet: Watchdog.RECOVERY_CAPABILITIES
            });
            this.journal(`escalate:${action}`, { escalated: true, action, error: String(error?.message ?? error) });
        }
        catch (escError) {
            telemetry.warn(`[watchdog] eskalasi otonom gagal: ${escError.message}`);
        }

    }

    journal(action, state) {

        try {

            const f = this.file();
            let j = [];
            try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* baru */ }

            j.push({
                at: new Date().toISOString(),
                action,
                state,
                healedBy: "aether-watchdog"
            });

            if (j.length > 200) j = j.slice(-200);

            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(j, null, 2));

        }
        catch { /* jurnal */ }

    }

    status() {
        return {
            running: this.running,
            prev: this.prev,
            voiceFailStreak: this.voiceFailStreak,
            lastVoiceError: this.lastVoiceError
        };
    }

}

module.exports = new Watchdog();
module.exports.Watchdog = Watchdog;
module.exports.decide = decide;
