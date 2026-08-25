const telemetry = require("./telemetryService");

/**
 * Kesadaran kontekstual rumah.
 *
 * Menyatukan sinyal dari SEMUA subsistem Aether menjadi satu
 * snapshot — inilah yang membuat Aether memahami rumah sebagai
 * satu kesatuan, bukan data terpisah. Setiap sumber diambil
 * dengan aman: subsistem yang belum diatur/offline hanya
 * dilaporkan "tidak tersedia", tidak menggagalkan yang lain.
 *
 * brief() meminta Aether merangkum snapshot itu jadi narasi
 * keadaan rumah (gaya "ringkasan pulang kerja" di visi Aether).
 */
class ContextService {

    async snapshot() {

        const parts = await Promise.allSettled([
            this.system(),
            this.ai(),
            this.memory(),
            this.integrations(),
            this.home(),
            this.sensors(),
            this.cameras(),
            this.people(),
            this.agents(),
            this.whatsapp(),
            this.devices()
        ]);

        const [
            system, ai, memory, integrations, home,
            sensors, cameras, people, agents, whatsapp, devices
        ] = parts.map(p => p.status === "fulfilled" ? p.value : { error: p.reason?.message });

        return {
            at: new Date().toISOString(),
            system, ai, memory, integrations, home,
            sensors, cameras, people, agents, whatsapp, devices
        };

    }

    system() {
        const s = telemetry.stats();
        return {
            host: s.host.hostname,
            cpu: s.cpu.usage,
            memory: s.memory.usedPercent,
            uptime: s.daemon.uptime
        };
    }

    async ai() {
        const aiRuntime = require("./aiRuntimeService");
        const p = await aiRuntime.providers();
        return {
            platform: aiRuntime.activePlatform?.label ?? p.active,
            model: aiRuntime.defaultModel,
            providers: p.providers.map(x => ({ id: x.id, online: x.online }))
        };
    }

    async memory() {
        const m = require("../memory/services/MemoryService");
        const s = await m.stats();
        return {
            memories: s.memories.total,
            entities: s.entities.total,
            documents: s.documents.total,
            embeddings: s.embeddings.available
        };
    }

    integrations() {
        const { manager } = require("../integrations");
        return manager.summary();
    }

    async home() {
        const home = require("./homeService");
        if (!home.configured) {
            return { configured: false };
        }
        const health = await home.health();
        if (!health.online) {
            return { configured: true, online: false };
        }
        return { configured: true, online: true, ...(await home.summary()) };
    }

    async sensors() {
        const sensorService = require("./sensorService");
        const readings = await sensorService.readAll();
        return {
            total: readings.length,
            readings: readings.map(r => ({
                label: r.label, value: r.value, unit: r.unit, ok: r.ok
            }))
        };
    }

    cameras() {
        const deviceService = require("./deviceService");
        const cams = deviceService.cameras();
        return { total: cams.length, cameras: cams.map(c => ({ id: c.id, label: c.label })) };
    }

    async people() {
        const immich = require("./immichService");
        if (!immich.configured) {
            return { configured: false };
        }
        return { configured: true, ...(await immich.summary()) };
    }

    async agents() {
        const agentHub = require("./agentHub");
        const list = await agentHub.health();
        return { agents: list.map(a => ({ id: a.id, online: a.online })) };
    }

    whatsapp() {
        const whatsapp = require("./whatsappService");
        const s = whatsapp.status();
        return { configured: s.configured, running: s.running, number: s.number };
    }

    devices() {
        const deviceService = require("./deviceService");
        return deviceService.readiness();
    }

    /** Rangkum snapshot jadi narasi keadaan rumah oleh Aether. */
    /**
     * N2-FINAL — giliran narasi mewarisi otoritas pemanggil.
     * Tanpa exec → 'user' least privilege; TIDAK ada system implisit.
     */
    async brief(exec = null) {

        const snap = await this.snapshot();

        const aiRuntime = require("./aiRuntimeService");

        // Ringkas snapshot jadi teks padat untuk dibaca model.
        const lines = [];

        lines.push(`Sistem: CPU ${snap.system?.cpu}%, RAM ${snap.system?.memory}%, host ${snap.system?.host}.`);

        if (snap.ai) {
            lines.push(`AI aktif: ${snap.ai.platform} (${snap.ai.model ?? "default"}).`);
        }

        if (snap.memory) {
            lines.push(`Memori: ${snap.memory.memories} catatan, ${snap.memory.entities} entitas, ${snap.memory.documents} dokumen.`);
        }

        if (snap.home?.online) {
            lines.push(`Rumah (Home Assistant): ${snap.home.on ?? 0} dari ${snap.home.total ?? 0} perangkat menyala.`);
        }
        else if (snap.home?.configured) {
            lines.push("Rumah: Home Assistant offline.");
        }

        if (snap.sensors?.total) {
            const s = snap.sensors.readings
                .filter(r => r.ok)
                .map(r => `${r.label} ${r.value}${r.unit ?? ""}`)
                .join(", ");
            if (s) lines.push(`Sensor: ${s}.`);
        }

        lines.push(`Integrasi: ${snap.integrations?.online ?? 0}/${snap.integrations?.enabled ?? 0} online.`);

        if (snap.agents?.agents) {
            const on = snap.agents.agents.filter(a => a.online).map(a => a.id).join(", ");
            lines.push(`Agent siap: ${on || "hanya aether"}.`);
        }

        if (snap.cameras?.total) {
            lines.push(`Kamera terdaftar: ${snap.cameras.total}.`);
        }

        if (snap.whatsapp?.running) {
            lines.push(`WhatsApp aktif (${snap.whatsapp.number ?? "tersambung"}).`);
        }

        const prompt =
            "Berikut sinyal terkini dari rumah & sistem yang kamu pantau. Sampaikan " +
            "ringkasan keadaan rumah yang singkat, hangat, dan berguna untuk pemilik — " +
            "seperti menyambut dia. Soroti hal yang perlu perhatian (beban tinggi, " +
            "perangkat menyala tanpa perlu, layanan offline) bila ada. Maksimal 4 kalimat, " +
            "bahasa Indonesia.\n\n" + lines.join("\n");

        try {
            // N2-FINAL: satu-satunya sumber peran = titik kanonik.
            const { resolveDelegator } = require("../ai/tools/Authorization");
            const delegator = resolveDelegator(exec ?? null);
            // M-1: restriction delegasi dalam bentuk sah apa pun.
            const briefSet = require("../ai/tools/Authorization")
                .toCapabilitySet(delegator?.capabilitySet);
            const response = await aiRuntime.chat({
                messages: [{ role: "user", content: prompt }],
                role: delegator?.role ?? "user",
                ...(briefSet ? { capabilitySet: briefSet } : {})
            });
            return { brief: response.content ?? "", snapshot: snap };
        }
        catch (error) {
            // Tanpa LLM, tetap beri ringkasan mentah agar berguna.
            return { brief: lines.join(" "), snapshot: snap, note: `LLM tak tersedia: ${error.message}` };
        }

    }

}

module.exports = new ContextService();
