const path = require("node:path");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Immich — mata Damar ke galeri foto.
 *
 * Immich sudah punya pengenalan wajah & pencarian cerdas bawaan.
 * Damar memanfaatkannya: daftar orang (wajah bernama), cari foto
 * per-orang, dan pencarian semantik ("foto saat ke Bandung naik
 * motor"). Auth pakai header x-api-key.
 *
 * Config (URL + API key) via Settings, disimpan lokal
 * (gitignored), key dimasking. Graceful bila belum diatur/offline.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "immich.json"),
    { url: null, key: null }
);

class ImmichService {

    cfg() {
        return store.read();
    }

    get url() {
        return (this.cfg().url || process.env.DAMAR_IMMICH_URL || "")
            .replace(/\/+$/, "") || null;
    }
    get key() {
        return this.cfg().key || process.env.DAMAR_IMMICH_KEY || null;
    }
    get configured() {
        return Boolean(this.url && this.key);
    }

    setConfig({ url, key } = {}) {
        const c = this.cfg();
        store.write({
            url: url !== undefined ? (url || null) : c.url,
            key: key === undefined ? c.key : (key || null)
        });
        return this.configView();
    }

    mask(k) {
        if (!k) return null;
        const s = String(k);
        return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
    }

    configView() {
        const c = this.cfg();
        return { url: c.url ?? "", hasKey: Boolean(c.key), keyHint: this.mask(c.key), configured: this.configured };
    }

    async api(path, { method = "GET", body = null, timeout = 12000 } = {}) {

        if (!this.configured) {
            const error = new Error("Immich belum dikonfigurasi (URL + API key di Settings).");
            error.code = "IMMICH_NOT_CONFIGURED";
            throw error;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const response = await fetch(`${this.url}/api${path}`, {
                method,
                headers: {
                    "x-api-key": this.key,
                    "Content-Type": "application/json",
                    Accept: "application/json"
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`Immich ${response.status}: ${detail.slice(0, 120)}`);
            }

            return response.json().catch(() => null);
        }
        catch (error) {
            if (error.name === "AbortError") throw new Error("Immich timeout.");
            if (error instanceof TypeError) throw new Error(`Tidak bisa menghubungi Immich di ${this.url}`);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }

    }

    async health() {
        if (!this.configured) {
            return { online: false, configured: false, error: "belum dikonfigurasi" };
        }
        try {
            // Butuh key valid: ambil info diri.
            await this.api("/users/me");
            return { online: true, configured: true };
        }
        catch (error) {
            return { online: false, configured: true, error: error.message };
        }
    }

    /** Orang (wajah bernama) yang dikenali Immich. */
    async people() {
        const data = await this.api("/people?withHidden=false");
        const list = data?.people ?? data ?? [];
        return list
            .filter(p => p.name)
            .map(p => ({ id: p.id, name: p.name, thumbnail: p.thumbnailPath ? `${this.url}/api/people/${p.id}/thumbnail` : null }));
    }

    /** Cari nama orang yang cocok (parsial, tanpa peka huruf). */
    async findPerson(name) {
        const people = await this.people();
        const q = String(name).toLowerCase();
        return people.filter(p => p.name.toLowerCase().includes(q));
    }

    /** Pencarian cerdas semantik (CLIP) — "foto ke Bandung naik motor". */
    async searchSmart(query, { limit = 20 } = {}) {
        const data = await this.api("/search/smart", {
            method: "POST",
            body: { query, size: limit }
        });
        return this.normalizeAssets(data);
    }

    /** Foto berdasarkan orang (dan opsional kata kunci). */
    async searchByPerson(personIds, { query, limit = 20 } = {}) {
        const body = { personIds, size: limit };
        if (query) body.query = query;
        const data = await this.api("/search/metadata", { method: "POST", body });
        return this.normalizeAssets(data);
    }

    normalizeAssets(data) {
        const items = data?.assets?.items ?? data?.assets ?? data?.items ?? [];
        return items.map(a => ({
            id: a.id,
            type: a.type,
            takenAt: a.exifInfo?.dateTimeOriginal ?? a.fileCreatedAt ?? null,
            place: a.exifInfo?.city ?? a.exifInfo?.state ?? null,
            fileName: a.originalFileName ?? null,
            thumbnail: `${this.url}/api/assets/${a.id}/thumbnail`
        }));
    }

    async summary() {
        try {
            const people = await this.people();
            return { people: people.length };
        }
        catch {
            return { people: 0 };
        }
    }

    /**
     * Unduh binary aset (foto/video) sebagai Buffer — untuk dikirim
     * ke WhatsApp/Telegram/Console. `kind`: "original" (default,
     * resolusi penuh) atau "thumbnail".
     */
    async assetBuffer(id, { kind = "original", timeout = 30000 } = {}) {

        if (!this.configured) {
            const error = new Error("Immich belum dikonfigurasi (URL + API key di Settings).");
            error.code = "IMMICH_NOT_CONFIGURED";
            throw error;
        }

        const path = kind === "thumbnail"
            ? `/api/assets/${id}/thumbnail`
            : `/api/assets/${id}/original`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {

            let response = await fetch(`${this.url}${path}`, {
                headers: { "x-api-key": this.key },
                signal: controller.signal
            });

            // Sebagian versi/fork Immich (mis. v3.1.0) TIDAK punya endpoint
            // thumbnail dan membalas 404, sementara /original tersedia.
            // Alih-alih gagal (foto blank), jatuh ke original.
            if (!response.ok && kind === "thumbnail") {
                response = await fetch(`${this.url}/api/assets/${id}/original`, {
                    headers: { "x-api-key": this.key },
                    signal: controller.signal
                });
            }

            if (!response.ok) {
                throw new Error(`Immich ${response.status} saat mengambil aset ${id}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const mime = response.headers.get("content-type") ?? "application/octet-stream";

            return { buffer, mime };

        }
        catch (error) {
            if (error.name === "AbortError") throw new Error("Immich timeout saat mengambil aset.");
            if (error instanceof TypeError) throw new Error(`Tidak bisa menghubungi Immich di ${this.url}`);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }

    }

}

module.exports = new ImmichService();
