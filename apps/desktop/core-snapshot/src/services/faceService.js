const path = require("node:path");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Pencocokan wajah untuk CCTV/live — mengenali SIAPA di gambar.
 *
 * Vision model bisa mendeskripsikan orang, tapi mengenali identitas
 * butuh mesin embedding wajah. Damar memakai layanan wajah
 * kompatibel-CompreFace (endpoint /api/v1/recognition/recognize)
 * yang bisa dijalankan lokal — cocok dengan filosofi Damar.
 *
 * Config (URL + API key) via Settings, gitignored, graceful.
 * Wajah didaftarkan/dilatih di layanan wajah itu; Damar hanya
 * mencocokkan.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "face.json"),
    { url: null, key: null }
);

class FaceService {

    cfg() {
        return store.read();
    }

    get url() {
        return (this.cfg().url || process.env.DAMAR_FACE_URL || "")
            .replace(/\/+$/, "") || null;
    }
    get key() {
        return this.cfg().key || process.env.DAMAR_FACE_KEY || null;
    }
    get configured() {
        return Boolean(this.url);
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

    /**
     * Kenali wajah pada gambar (base64). Mengembalikan daftar wajah
     * terdeteksi + nama tebakan (bila cocok) + skor keyakinan.
     */
    async recognize(imageBase64, { threshold = 0.85 } = {}) {

        if (!this.configured) {
            const error = new Error(
                "Layanan wajah belum dikonfigurasi. Jalankan CompreFace (atau kompatibel) " +
                "dan isi URL + API key di Settings → Wajah."
            );
            error.code = "FACE_NOT_CONFIGURED";
            throw error;
        }

        const buffer = Buffer.from(imageBase64, "base64");

        const form = new FormData();
        form.append("file", new Blob([buffer], { type: "image/jpeg" }), "frame.jpg");

        const headers = {};
        if (this.key) {
            headers["x-api-key"] = this.key;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);

        try {
            const response = await fetch(
                `${this.url}/api/v1/recognition/recognize?limit=0&det_prob_threshold=0.8&face_plugins=`,
                { method: "POST", headers, body: form, signal: controller.signal }
            );

            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`Layanan wajah ${response.status}: ${detail.slice(0, 120)}`);
            }

            const data = await response.json();

            const faces = (data?.result ?? []).map(f => {
                const top = (f.subjects ?? [])[0];
                return {
                    name: top && top.similarity >= threshold ? top.subject : null,
                    similarity: top?.similarity ?? 0,
                    box: f.box ?? null
                };
            });

            telemetry.publish("face:recognized", {
                faces: faces.length,
                known: faces.filter(f => f.name).length
            });

            return { faces };
        }
        catch (error) {
            if (error.name === "AbortError") throw new Error("Layanan wajah timeout.");
            if (error instanceof TypeError) throw new Error(`Tidak bisa menghubungi layanan wajah di ${this.url}`);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }

    }

    /** Ringkas hasil jadi kalimat untuk Damar/pengguna. */
    describe(faces) {
        if (faces.length === 0) return "Tidak ada wajah terdeteksi.";
        const known = faces.filter(f => f.name).map(f => f.name);
        const unknown = faces.length - known.length;
        const parts = [];
        if (known.length) parts.push(`dikenali: ${known.join(", ")}`);
        if (unknown) parts.push(`${unknown} wajah belum dikenal`);
        return `${faces.length} wajah terdeteksi (${parts.join("; ")}).`;
    }

}

module.exports = new FaceService();
