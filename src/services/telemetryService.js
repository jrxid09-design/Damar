const EventEmitter = require("node:events");

const os = require("node:os");

/**
 * Sumber kebenaran untuk apa yang terjadi di dalam Aether saat ini.
 *
 * Menyimpan log terbaru di ring buffer (bukan file) supaya Aether
 * Console bisa langsung menampilkan riwayat begitu terhubung —
 * tanpa itu, panel log selalu kosong sampai kejadian berikutnya.
 */
class TelemetryService extends EventEmitter {

    constructor({ capacity = 500 } = {}) {

        super();

        // Banyak klien SSE boleh menyimak sekaligus.
        this.setMaxListeners(50);

        this.capacity = capacity;

        /** @type {Array<object>} */
        this.buffer = [];

        this.sequence = 0;

        this.startedAt = Date.now();

        /** Snapshot CPU sebelumnya, untuk menghitung persentase pemakaian. */
        this.previousCpu = this.readCpu();

    }

    log(level, message, meta = {}) {

        const entry = {
            id: ++this.sequence,
            time: new Date().toISOString(),
            level,
            message,
            meta
        };

        this.buffer.push(entry);

        if (this.buffer.length > this.capacity) {
            this.buffer.shift();
        }

        this.emit("log", entry);

        return entry;

    }

    info(message, meta) {
        return this.log("info", message, meta);
    }

    warn(message, meta) {
        return this.log("warn", message, meta);
    }

    error(message, meta) {
        return this.log("error", message, meta);
    }

    debug(message, meta) {
        return this.log("debug", message, meta);
    }

    /** Event non-log (perubahan status integrasi, siklus request AI, dst). */
    publish(type, payload = {}) {

        const event = {
            id: ++this.sequence,
            time: new Date().toISOString(),
            type,
            payload
        };

        this.emit("event", event);

        return event;

    }

    logs({ limit = 200, level = null } = {}) {

        let entries = this.buffer;

        if (level) {
            entries = entries.filter(entry => entry.level === level);
        }

        return entries.slice(-limit);

    }

    clear() {

        this.buffer = [];

        return this;

    }

    // ---- Metrik host --------------------------------------------

    readCpu() {

        const cpus = os.cpus();

        let idle = 0;
        let total = 0;

        for (const cpu of cpus) {

            for (const type of Object.keys(cpu.times)) {
                total += cpu.times[type];
            }

            idle += cpu.times.idle;

        }

        return { idle, total };

    }

    /**
     * Pemakaian CPU dihitung sebagai selisih antar pemanggilan,
     * bukan nilai sesaat — os.cpus() melaporkan akumulasi sejak
     * boot, jadi tanpa pembanding angkanya tidak berarti.
     */
    cpuUsage() {

        const current = this.readCpu();

        const idleDelta = current.idle - this.previousCpu.idle;
        const totalDelta = current.total - this.previousCpu.total;

        this.previousCpu = current;

        if (totalDelta <= 0) {
            return 0;
        }

        return Number(
            (100 - (idleDelta / totalDelta) * 100).toFixed(1)
        );

    }

    stats() {

        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const usedMemory = totalMemory - freeMemory;

        const processMemory = process.memoryUsage();

        return {

            host: {
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                cpuModel: os.cpus()[0]?.model ?? "unknown",
                cpuCount: os.cpus().length,
                uptime: os.uptime()
            },

            cpu: {
                usage: this.cpuUsage(),
                loadAverage: os.loadavg()
            },

            memory: {
                total: totalMemory,
                free: freeMemory,
                used: usedMemory,
                usedPercent: Number(((usedMemory / totalMemory) * 100).toFixed(1))
            },

            process: {
                pid: process.pid,
                uptime: process.uptime(),
                nodeVersion: process.version,
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss
            },

            daemon: {
                startedAt: new Date(this.startedAt).toISOString(),
                uptime: (Date.now() - this.startedAt) / 1000,
                logCount: this.buffer.length
            }

        };

    }

}

module.exports = new TelemetryService();
