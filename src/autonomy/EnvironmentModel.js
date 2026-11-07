const os = require("node:os");

const telemetry = require("../services/telemetryService");

/**
 * ENVIRONMENT MODEL (§9 + §42) — representasi machine-readable host.
 *
 * Snapshot ringan (dipanggil berkala / saat OBSERVE): CPU/RAM/disk/
 * jaringan/proses inti. Tidak berat: tanpa spawn, hanya API node.
 */
class EnvironmentModel {

    async snapshot() {

        const [mem, disk, net, procs] = await Promise.all([
            this.memory(),
            this.disk().catch(() => null),
            this.network().catch(() => ({ online: false })),
            this.processes().catch(() => [])
        ]);

        return {
            timestamp: new Date().toISOString(),
            platform: os.platform(),
            host: os.hostname(),
            memory: mem,
            disk,
            network: net,
            processes: procs,
            load: os.loadavg?.() ?? [0, 0, 0]
        };

    }

    async memory() {
        return {
            freeGb: +(os.freemem() / 1e9).toFixed(1),
            totalGb: +(os.totalmem() / 1e9).toFixed(1),
            usedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100)
        };
    }

    async disk() {

        const fs = require("node:fs");

        const targets = [
            { label: "cwd", path: process.cwd() },
            { label: "os", path: os.tmpdir() }
        ];

        const out = [];

        for (const t of targets) {
            try {
                const st = fs.statfsSync(t.path);
                out.push({
                    label: t.label,
                    freeGb: +((st.bavail * st.bsize) / 1e9).toFixed(1),
                    totalGb: +((st.blocks * st.bsize) / 1e9).toFixed(1)
                });
            }
            catch { /* lompat */ }
        }

        return out;

    }

    async network() {

        // Deteksi online murah: resolve DNS publik.
        const dns = require("node:dns").promises;

        try {
            await dns.resolve4("one.one.one.one");
            return { online: true };
        }
        catch {
            return { online: false };
        }

    }

    /** Proses inti Damar (node) — ringkas, tanpa ps spawn. */
    async processes() {
        return {
            pid: process.pid,
            uptimeH: +(process.uptime() / 3600).toFixed(1),
            nodeVersion: process.version,
            memoryRssMb: Math.round(process.memoryUsage().rss / 1e6)
        };
    }

    /** Kesadaran sumber daya (§42): strategi berdasarkan ketersediaan. */
    async strategy() {

        const snap = await this.snapshot();

        const hints = [];

        if (snap.memory.usedPercent > 90) hints.push("RAM tinggi → hindari tugas paralel besar, proses streaming");
        if (snap.disk?.some(d => d.freeGb < 2)) hints.push("disk kritis → hindari unduhan/checkpoint besar");
        if (snap.network.online === false) hints.push("offline → model lokal, tanpa web/API eksternal");
        if ((snap.load?.[0] ?? 0) > 4) hints.push("beban CPU tinggi → tugas berat ditunda");

        return { environment: snap, hints, canHeavy: snap.memory.usedPercent < 85 };

    }

    /**
     * Tanda tangan keadaan — HANYA hal yang mengubah keputusan.
     *
     * Timestamp, RSS, dan uptime berubah tiap detak tanpa memberi tahu
     * apa pun; memasukkannya berarti setiap snapshot selalu "berbeda".
     * Yang dipakai di sini pita kasar: online/offline, RAM per 5%,
     * sisa disk per GB, beban CPU per satuan.
     */
    signature(snap) {
        return [
            snap.network?.online === true ? "on" : "off",
            Math.round((snap.memory?.usedPercent ?? 0) / 5),
            (snap.disk ?? []).map(d => `${d.label}:${Math.round(d.freeGb)}`).join(","),
            Math.round(snap.load?.[0] ?? 0)
        ].join("|");
    }

    /**
     * Pantau lingkungan tanpa membanjiri log.
     *
     * Modelnya tetap disegarkan tiap menit (murah dan berguna), tetapi
     * hanya DITERBITKAN saat keadaan benar-benar bergeser. Detak tiap
     * menit yang isinya sama bukan sinyal — ia menenggelamkan kejadian
     * nyata di aliran log pemilik.
     */
    startWatch(intervalMs = 60000) {
        if (this.timer) return;
        this.timer = setInterval(async () => {
            try {
                const snap = await this.snapshot();
                this.last = snap;
                const sig = this.signature(snap);
                if (sig === this.lastSignature) return;
                this.lastSignature = sig;
                telemetry.publish("autonomy:environment", snap);
            }
            catch { /* abaikan */ }
        }, intervalMs);
        this.timer.unref?.();
    }

    stopWatch() {
        clearInterval(this.timer);
        this.timer = null;
    }

}

module.exports = new EnvironmentModel();
