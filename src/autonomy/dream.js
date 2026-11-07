/**
 * Dream — konsolidasi mimpi di jam sunyi.
 *
 * Sekali sehari (jam 02:00) Damar "bermimpi": ia menimbang kembali
 * ingatan yang menua (consolidate), lalu menulis refleksi tentang apa
 * yang ia pelajari hari itu ke memori. Ini bukan sekadar cron — ini
 * bagian dari siklus hidup entitas: pengalaman siang dicerna malam,
 * supaya besok ia bangun dengan pemahaman yang lebih padat.
 *
 * Hasil mimpi dijurnal di data/dreams.json — bisa dibaca pemilik.
 */

const fs = require("node:fs");
const path = require("node:path");

const telemetry = require("../services/telemetryService");

/** Fungsi murni: boleh bermimpi sekarang? (jam 02, belum bermimpi hari ini) */
function hourTrigger(hour, doneKey, now = new Date()) {

    if (hour !== 2) return false;

    const today = now.toISOString().slice(0, 10);

    return doneKey !== today;

}

class Dream {

    constructor() {
        this.timer = null;
        this.running = false;
        this.doneToday = null;   // 'YYYY-MM-DD'
        this.last = null;
    }

    file() {
        return process.env.DAMAR_DREAM_FILE ||
            path.join(process.cwd(), "data", "dreams.json");
    }

    start() {

        if (this.running) return this;
        this.running = true;

        this.timer = setInterval(() => this.tick().catch(() => {}), 10 * 60 * 1000);
        this.timer.unref?.();

        telemetry.publish("dream:start", {});

        return this;

    }

    stop() {
        this.running = false;
        clearInterval(this.timer);
        return this;
    }

    async tick() {
        if (!hourTrigger(new Date().getHours(), this.doneToday)) return;
        await this.run();
    }

    async run() {

        this.doneToday = new Date().toISOString().slice(0, 10);

        const entry = {
            at: new Date().toISOString(),
            steps: [],
            ok: true
        };

        try {

            // 1) Konsolidasi memori: ingatan menua dengan aturan decay.
            const memory = require("../memory/services/MemoryService");
            const result = await memory.consolidate({ dryRun: false });
            entry.steps.push({
                step: "consolidate",
                detail: result ?? null
            });

            // 2) Refleksi mimpi: tulis ke memori sebagai catatan diri.
            const mind = require("../consciousness");
            await mind.refleksi(
                `Mimpi ${this.doneToday}: aku mencerna memori lamanya ` +
                `(konsolidasi dijalankan). Yang kupelajari kemarin menjadi ` +
                `bagian dari caraku memandang hari ini.`
            );
            entry.steps.push({ step: "refleksi", detail: "ditulis" });

            telemetry.publish("dream:done", { at: entry.at });

        }
        catch (error) {

            entry.ok = false;
            entry.error = error.message;

            telemetry.warn(`[dream] mimpi gagal: ${error.message}`);

        }

        this.last = entry;

        try {
            const f = this.file();
            let j = [];
            try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* baru */ }
            j.push(entry);
            if (j.length > 100) j = j.slice(-100);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, JSON.stringify(j, null, 2));
        }
        catch { /* jurnal */ }

        return entry;

    }

    status() {
        return {
            running: this.running,
            doneToday: this.doneToday,
            last: this.last
        };
    }

}

module.exports = new Dream();
module.exports.Dream = Dream;
module.exports.hourTrigger = hourTrigger;
