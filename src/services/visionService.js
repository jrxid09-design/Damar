const path = require("node:path");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

/**
 * Vision — Aether "melihat" gambar (frame kamera/CCTV, foto).
 *
 * Memakai engine AI yang sama dengan bentuk pesan multimodal
 * OpenAI-compatible: content array [{type:text},{type:image_url}].
 *
 * Model vision dipilih terpisah dari model chat (chat model belum
 * tentu bisa melihat). Diatur di Settings; tanpa model vision,
 * fitur melapor belum siap dengan anggun.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "vision.json"),
    { model: null }
);

class VisionService {

    cfg() {
        return store.read();
    }

    /** Model vision aktif. Default masuk akal per jenis provider. */
    model() {

        const configured = this.cfg().model || process.env.AETHER_VISION_MODEL;

        if (configured) {
            return configured;
        }

        const aiRuntime = require("./aiRuntimeService");
        const kind = aiRuntime.activePlatform?.kind;

        // Cloud: biarkan null agar pengguna memilih (nama model bervariasi).
        return null;

    }

    get configured() {
        return Boolean(this.model());
    }

    setConfig({ model } = {}) {
        store.write({ model: model !== undefined ? (model || null) : this.cfg().model });
        return this.configView();
    }

    configView() {
        return {
            model: this.cfg().model ?? "",
            effective: this.model(),
            configured: this.configured
        };
    }

    /**
     * Analisis satu gambar.
     * @param {object} opts
     * @param {string} opts.imageBase64  base64 tanpa prefix data:
     * @param {string} [opts.mimeType]
     * @param {string} [opts.prompt]
     * @returns {Promise<{ text:string, model:string }>}
     */
    async analyze({ imageBase64, mimeType = "image/jpeg", prompt, exec = null } = {}) {

        if (!imageBase64) {
            throw new Error("Gambar kosong.");
        }

        const question = prompt ||
            "Deskripsikan isi gambar ini secara ringkas dalam bahasa Indonesia: " +
            "ada siapa/apa, aktivitas, dan hal yang menonjol.";

        // Provider chat aktif tidak selalu bisa melihat (proxy lokal
        // sering diam-diam membuang lampiran gambar). Utamakan jalur
        // yang benar-benar mengirim gambar ke model vision:
        //   1. API Gemini resmi, bila key Google tersedia
        //   2. provider chat aktif (OpenAI-compatible) sebagai cadangan
        const geminiKey = this.geminiKey();

        if (geminiKey) {
            try {
                return await this.analyzeGemini({ imageBase64, mimeType, question, geminiKey });
            }
            catch (error) {
                telemetry.warn(`[vision] jalur Gemini gagal: ${error.message} — coba provider aktif`);
            }
        }

        const model = this.model();

        if (!model) {
            const error = new Error(
                "Model vision belum diatur. Pilih model vision cloud " +
                "di Settings → Vision."
            );
            error.code = "VISION_NOT_CONFIGURED";
            throw error;
        }

        const aiRuntime = require("./aiRuntimeService");

        const message = {
            role: "user",
            content: [
                { type: "text", text: question },
                {
                    type: "image_url",
                    image_url: { url: `data:${mimeType};base64,${imageBase64}` }
                }
            ]
        };

        // N2-FINAL: giliran visi mewarisi otoritas pemanggil —
        // TIDAK ada system implisit; tanpa exec → 'user'.
        // A-FINAL/H1-CLOSURE: restriction delegasi (capabilitySet)
        // menyeberang sebagai SATU identitas kanonik (`exec`) — bukan
        // role+capabilitySet terpisah yang rawan terpotong di hop
        // direct/fallback runtime.
        const { resolveDelegator } = require("../ai/tools/Authorization");
        const delegator = resolveDelegator(exec ?? null);
        const response = await aiRuntime.ensure().chat({
            messages: [message],
            model,
            ...(delegator ? { exec: delegator } : {})
        });

        telemetry.publish("vision:analyzed", {
            model,
            chars: (response.content ?? "").length
        });

        return { text: response.content ?? "", model };

    }

    /** API key Google bila dikonfigurasi di providers.json. */
    geminiKey() {

        try {
            const cfg = require("./providerConfigService").read();
            const g = cfg?.providers?.google;

            return g?.apiKey && !/dummy/i.test(g.apiKey) ? g.apiKey : null;
        }
        catch {
            return null;
        }

    }

    /** Model vision Gemini — bawaan flash terkini bila tidak diatur. */
    geminiModel() {

        const m = this.cfg().model;

        // Model yang jelas-jelas bukan Gemini tidak dipaksakan ke
        // endpoint Google.
        if (m && /gemini/i.test(m)) return m;

        return "gemini-flash-latest";

    }

    /**
     * Analisis lewat API Gemini resmi (`generateContent` dengan
     * `inline_data`) — jalur yang terbukti mengirim gambar ke model.
     */
    async analyzeGemini({ imageBase64, mimeType, question, geminiKey }) {

        const model = this.geminiModel();

        const url =
            `https://generativelanguage.googleapis.com/v1beta/models/` +
            `${encodeURIComponent(model)}:generateContent`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);

        try {

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": geminiKey
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: question },
                            { inline_data: { mime_type: mimeType, data: imageBase64 } }
                        ]
                    }]
                }),
                signal: controller.signal
            });

            const data = await response.json().catch(() => null);

            if (!response.ok) {
                throw new Error(
                    `Gemini ${response.status}: ` +
                    (data?.error?.message ?? "permintaan gagal").slice(0, 140)
                );
            }

            const text = data?.candidates?.[0]?.content?.parts
                ?.map(p => p.text ?? "").join("").trim();

            if (!text) {
                throw new Error("Gemini tidak mengembalikan deskripsi.");
            }

            telemetry.publish("vision:analyzed", { model, chars: text.length });

            return { text, model };

        }
        finally {
            clearTimeout(timer);
        }

    }

    /**
     * Ambil gambar dari URL lalu analisis.
     *
     * D-FINAL — SSRF GUARD:
     *   policy "public" (default)  → URL model/pengguna (describe_image):
     *                                skema http(s), tolak loopback/RFC1918/
     *                                link-local/metadata/IPv6-lokal,
     *                                validasi DNS, redirect divalidasi
     *                                per-hop, batas ukuran & waktu.
     *   policy "trusted-lan"       → HANYA snapshot kamera/perangkat yang
     *                                berasal dari registry internal
     *                                (deviceService) — cek privat dilewati,
     *                                batas skema/waktu/ukuran tetap.
     * URL arbitrer dari argumen TIDAK PERNAH boleh memakai trusted-lan:
     * kepercayaan menempel pada SUMBER URL, bukan pada pemanggil.
     *
     * @param {object} opts { url, prompt?, headers?, exec?,
     *                        policy?="public"|"trusted-lan" }
     */
    async analyzeUrl({ url, prompt, headers = {}, exec = null, policy = "public" } = {}) {

        if (!url) {
            throw new Error("URL kamera kosong.");
        }

        const ssrf = require("../core/safety/ssrfGuard");

        let imageBase64;
        let mimeType;

        try {

            const { buffer, response } = await ssrf.guardedFetch(url, {
                headers,
                policy: policy === "trusted-lan" ? "trusted-lan" : "public",
                timeoutMs: 15000,
                maxBytes: 10 * 1024 * 1024,
                requireImage: true
            });

            mimeType = response.headers.get("content-type") || "image/jpeg";
            imageBase64 = buffer.toString("base64");
        }
        catch (error) {
            if (error.name === "AbortError") {
                throw new Error("Snapshot kamera timeout.");
            }
            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa mengambil snapshot dari ${url}`);
            }
            throw error;
        }

        return this.analyze({ imageBase64, mimeType, prompt, exec });

    }

    status() {
        return {
            configured: this.configured,
            model: this.model()
        };
    }

}

module.exports = new VisionService();
