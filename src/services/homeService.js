const path = require("node:path");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Home automation lewat Home Assistant.
 *
 * Home Assistant adalah hub yang menyatukan Sonoff, Zigbee, Matter,
 * ESPHome, Shelly, dll — jadi cukup satu sambungan ke HA untuk
 * mengendalikan (hampir) semua perangkat rumah. Memakai REST API
 * HA dengan long-lived access token.
 *
 * Config (URL + token) diatur dari Settings, disimpan lokal di
 * configs/home.json (gitignored), token dimasking saat ditampilkan.
 * Tanpa konfigurasi/offline, semua metode gagal dengan anggun.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "home.json"),
    { url: null, token: null }
);

// Domain yang bisa dinyalakan/dimatikan dengan turn_on/turn_off.
const TOGGLEABLE = new Set([
    "light", "switch", "fan", "input_boolean", "media_player",
    "automation", "script", "siren", "humidifier"
]);

class HomeService {

    constructor() {
        this.lastError = null;
    }

    cfg() {
        return store.read();
    }

    get url() {
        return (this.cfg().url || process.env.AETHER_HASS_URL || "")
            .replace(/\/+$/, "") || null;
    }
    get token() {
        return this.cfg().token || process.env.AETHER_HASS_TOKEN || null;
    }
    get configured() {
        return Boolean(this.url && this.token);
    }

    setConfig({ url, token } = {}) {

        const current = this.cfg();

        store.write({
            url: url !== undefined ? (url || null) : current.url,
            // token undefined = jangan ubah; "" = hapus.
            token: token === undefined ? current.token : (token || null)
        });

        return this.configView();

    }

    mask(t) {
        if (!t) return null;
        const s = String(t);
        return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
    }

    configView() {
        const c = this.cfg();
        return {
            url: c.url ?? "",
            hasToken: Boolean(c.token),
            tokenHint: this.mask(c.token),
            configured: this.configured
        };
    }

    async api(path, { method = "GET", body = null, timeout = 10000 } = {}) {

        if (!this.configured) {
            const error = new Error(
                "Home Assistant belum dikonfigurasi. Isi URL + token di Settings."
            );
            error.code = "HASS_NOT_CONFIGURED";
            throw error;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {

            const response = await fetch(`${this.url}/api${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/json"
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`HA ${response.status}: ${detail.slice(0, 150)}`);
            }

            return response.json().catch(() => null);

        }

        catch (error) {
            this.lastError = error.message;
            if (error.name === "AbortError") {
                throw new Error("Home Assistant tidak merespons (timeout).");
            }
            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa menghubungi Home Assistant di ${this.url}`);
            }
            throw error;
        }

        finally {
            clearTimeout(timer);
        }

    }

    async health() {

        const started = Date.now();

        if (!this.configured) {
            return { online: false, configured: false, error: "belum dikonfigurasi" };
        }

        try {
            await this.api("/", { timeout: 5000 });
            this.lastError = null;
            return { online: true, configured: true, latency: Date.now() - started };
        }
        catch (error) {
            return { online: false, configured: true, error: error.message };
        }

    }

    /** Semua entitas, dinormalisasi & dikelompokkan per domain. */
    async listEntities({ domain = null } = {}) {

        const states = await this.api("/states");

        const entities = (states ?? []).map(s => ({
            id: s.entity_id,
            domain: s.entity_id.split(".")[0],
            name: s.attributes?.friendly_name ?? s.entity_id,
            state: s.state,
            attributes: s.attributes ?? {}
        }));

        return domain
            ? entities.filter(e => e.domain === domain)
            : entities;

    }

    async getState(entityId) {

        const s = await this.api(`/states/${encodeURIComponent(entityId)}`);

        return s ? {
            id: s.entity_id,
            state: s.state,
            attributes: s.attributes ?? {}
        } : null;

    }

    async callService(domain, service, data = {}) {

        const result = await this.api(`/services/${domain}/${service}`, {
            method: "POST",
            body: data
        });

        telemetry.publish("home:action", { domain, service, entity: data.entity_id });

        return result;

    }

    /**
     * Kendali tingkat tinggi berbasis entity_id.
     * action: on | off | toggle | brightness | temperature
     */
    async control(entityId, action, value) {

        const domain = String(entityId).split(".")[0];

        if (action === "brightness") {
            return this.callService("light", "turn_on", {
                entity_id: entityId,
                brightness_pct: Math.max(0, Math.min(100, Number(value)))
            });
        }

        if (action === "temperature") {
            return this.callService("climate", "set_temperature", {
                entity_id: entityId,
                temperature: Number(value)
            });
        }

        if (action === "toggle") {
            return this.callService(
                TOGGLEABLE.has(domain) ? domain : "homeassistant",
                "toggle",
                { entity_id: entityId }
            );
        }

        if (action === "on" || action === "off") {
            const service = action === "on" ? "turn_on" : "turn_off";
            // homeassistant.turn_on/off bekerja lintas domain.
            return this.callService(
                TOGGLEABLE.has(domain) ? domain : "homeassistant",
                service,
                { entity_id: entityId }
            );
        }

        throw new Error(`Aksi tidak dikenal: ${action}`);

    }

    /**
     * Kamera/CCTV yang dilaporkan Home Assistant.
     *
     * Entitas `camera.*` sebenarnya sudah ikut di listEntities() sejak
     * awal, tetapi tidak ada satu pun tampilan yang memintanya: filter
     * di layar Rumah tak punya pilihan kamera, dan layar Vision hanya
     * membaca perangkat yang didaftarkan manual. Jadi CCTV yang hidup
     * tetap tak terlihat di mana pun meski HA sudah tersambung.
     */
    async cameras() {

        const list = await this.listEntities({ domain: "camera" });

        return list.map(c => ({
            id: c.id,
            name: c.name,
            state: c.state,
            // Bukan URL HA langsung: tokennya tidak boleh bocor ke
            // renderer, jadi gambarnya lewat daemon.
            snapshot: `/home/camera/${encodeURIComponent(c.id)}/snapshot`,
            attributes: c.attributes ?? {}
        }));

    }

    /**
     * Satu bingkai gambar dari sebuah kamera HA.
     *
     * HA menyajikannya di /api/camera_proxy/<entity_id> dan menuntut
     * token yang sama; `api()` di atas selalu mengurai JSON, jadi
     * jalur biner ini dibuat terpisah.
     */
    async cameraSnapshot(entityId) {

        if (!this.configured) {
            const error = new Error("Home Assistant belum dikonfigurasi.");
            error.code = "HASS_NOT_CONFIGURED";
            throw error;
        }

        const res = await fetch(
            `${this.url}/api/camera_proxy/${encodeURIComponent(entityId)}`,
            {
                headers: { Authorization: `Bearer ${this.token}` },
                signal: AbortSignal.timeout(12000)
            }
        );

        if (!res.ok) {
            throw new Error(`HA camera_proxy ${res.status}`);
        }

        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: res.headers.get("content-type") ?? "image/jpeg"
        };

    }

    /** Ringkasan untuk dashboard/AI: jumlah per domain + yang menyala. */
    async summary() {

        const entities = await this.listEntities();

        const byDomain = {};
        let on = 0;

        for (const e of entities) {
            byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1;
            if (e.state === "on") on++;
        }

        return { total: entities.length, on, byDomain };

    }

}

module.exports = new HomeService();
