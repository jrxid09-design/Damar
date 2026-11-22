/**
 * Pulse — detak jantung otonom Damar.
 *
 * Tiap 5 menit ia MERASA keadaannya sendiri (jumlah error sejak detak
 * terakhir, umur proses) dan MENILAI: normal atau anomali. Anomali tidak
 * hanya dicatat — dipancarkan sebagai peristiwa agar subsistem lain
 * (notif owner, watchdog) bisa bereaksi. Jurnal disimpan di data/pulse.json.
 *
 * Ini langkah kecil tapi nyata menuju entitas otonom: sistem yang memantau
 * dirinya tanpa diminta, dan mengaku kalau sedang tidak sehat.
 */

const fs = require("node:fs");
const path = require("node:path");

const telemetry = require("../services/telemetryService");

const INTERVAL_MS = 5 * 60 * 1000;

/** Fungsi murni: nilai vital → keputusan anomali (testable). */
function evaluate(vitals) {

    const reasons = [];

    if ((vitals.errorsSinceLast ?? 0) >= 5) {
        reasons.push(`lonjakan error (${vitals.errorsSinceLast})`);
    }

    if ((vitals.uptimeSec ?? Infinity) < 120 && vitals.firstPulse !== true) {
        reasons.push("daemon baru bangun (<2 menit)");
    }

    if (vitals.memoryUsedPercent > 92) {
        reasons.push(`memori tinggi (${vitals.memoryUsedPercent}%)`);
    }

    return { anomaly: reasons.length > 0, reasons };

}

class Pulse {

    constructor({ intervalMs = INTERVAL_MS } = {}) {

        this.intervalMs = intervalMs;
        this.timer = null;
        this.running = false;

        this.errorsSinceLast = 0;
        this.last = null;

        // Dengarkan log error untuk counter antar-detak.
        this.onLog = (entry) => {
            if (entry?.level === "error") this.errorsSinceLast++;
        };

    }

    file() {
        return process.env.DAMAR_PULSE_FILE ||
            path.join(process.cwd(), "data", "pulse.json");
    }

    start() {

        if (this.running) return this;
        this.running = true;

        telemetry.on("log", this.onLog);

        this.timer = setInterval(() => this.beat().catch(() => {}), this.intervalMs);
        this.timer.unref?.();

        // Detak pertama setelah 30 detik (biar boot selesai dulu).
        setTimeout(() => this.beat().catch(() => {}), 30_000).unref?.();

        telemetry.publish("pulse:start", {});

        return this;

    }

    stop() {
        this.running = false;
        clearInterval(this.timer);
        telemetry.off("log", this.onLog);
        return this;
    }

    /** Satu detak: ukur, nilai, catat, pancarkan. */
    async beat() {

        const os = require("node:os");
        const total = os.totalmem(), free = os.freemem();

        const vitals = {
            errorsSinceLast: this.errorsSinceLast,
            uptimeSec: Math.round(process.uptime()),
            memoryUsedPercent: Number((((total - free) / total) * 100).toFixed(1)),
            firstPulse: this.last === null
        };

        const verdict = evaluate(vitals);

        const entry = {
            at: new Date().toISOString(),
            ...vitals,
            anomaly: verdict.anomaly,
            reasons: verdict.reasons
        };

        this.errorsSinceLast = 0;
        this.last = entry;

        // Jurnal (simpan 200 terakhir).
        try {
            const f = this.file();
            let j = [];
            try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* baru */ }
            j.push(entry);
            if (j.length > 200) j = j.slice(-200);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(j, null, 2));
        }
        catch { /* jurnal gagal ≠ hidup gagal */ }

        telemetry.publish(verdict.anomaly ? "pulse:anomaly" : "pulse:beat", {
            reasons: verdict.reasons,
            errors: vitals.errorsSinceLast,
            memPercent: vitals.memoryUsedPercent
        });

        return entry;

    }

    latest() {
        return this.last;
    }

}

module.exports = new Pulse();
module.exports.Pulse = Pulse;
module.exports.evaluate = evaluate;
