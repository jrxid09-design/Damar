const path = require("node:path");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Lapisan proaktif — Damar menyapa lebih dulu.
 *
 * Versi minimal: satu "brief" harian terjadwal (ringkasan keadaan
 * rumah dari contextService) yang dikirim ke WhatsApp yang diizinkan.
 * Merakit potongan yang sudah ada (contextService.brief +
 * whatsapp.broadcast), bukan mesin jadwal baru.
 *
 * ponytail: scheduler = cek tiap 60 dtk + banding "HH:MM" lokal;
 * resolusi menit, satu brief/hari. Kalau butuh cron penuh / banyak
 * jadwal, ganti ke node-cron nanti.
 */

const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "automation.json"),
    { enabled: false, time: "07:00", lastSent: null }
);

/** Pure & testable: apakah brief harus dikirim sekarang? */
function due(now, time, lastSent) {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    if (`${hh}:${mm}` !== time) return false;
    return lastSent !== dayKey(now);        // maksimal sekali per hari
}

function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

class AutomationService {

    constructor() {
        this.timer = null;
    }

    start() {
        if (this.timer) return this;
        // Cek tiap menit; ringan.
        this.timer = setInterval(() => this.tick().catch(() => {}), 60000);
        return this;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return this;
    }

    async tick() {
        const cfg = store.read();
        if (!cfg.enabled) return;
        const now = new Date();
        if (!due(now, cfg.time, cfg.lastSent)) return;

        store.write({ lastSent: dayKey(now) });   // tandai dulu → hindari dobel
        await this.runBrief();
    }

    /** Susun brief lalu kirim ke WhatsApp yang diizinkan. */
    async runBrief() {
        const contextService = require("./contextService");
        const whatsapp = require("./whatsappService");

        const { brief } = await contextService.brief();
        const recipients = await whatsapp.broadcast(`☀️ Damar:\n\n${brief}`);

        telemetry.publish("automation:brief", { recipients, chars: brief.length });
        return { brief, recipients };
    }

    configure({ enabled, time } = {}) {
        const cfg = store.read();
        store.write({
            enabled: enabled !== undefined ? Boolean(enabled) : cfg.enabled,
            time: time !== undefined ? String(time) : cfg.time
        });
        return this.status();
    }

    status() {
        const cfg = store.read();
        return { enabled: cfg.enabled, time: cfg.time, lastSent: cfg.lastSent, running: Boolean(this.timer) };
    }

}

module.exports = new AutomationService();
module.exports.due = due;        // untuk self-check
