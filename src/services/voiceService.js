const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

const pexec = promisify(execFile);

/**
 * Suara ARDI (buatan Aether) memakai edge-tts (Microsoft Neural,
 * id-ID-ArdiNeural — pria Indonesia). Berbeda dari Kokoro: disintesis
 * lokal lewat CLI edge-tts, dikembalikan sebagai mp3 dan diputar di
 * Console seperti suara neural lain. resolveEdge menerjemahkan alias.
 */
function resolveEdge(want) {
    const v = String(want ?? "").trim();
    if (!v) return null;
    if (/^[a-z]{2}-[A-Z]{2}-\w+/i.test(v)) return v;   // mis. id-ID-ArdiNeural
    if (/^ardi$/i.test(v)) return "id-ID-ArdiNeural";  // alias ramah
    return null;
}

async function edgeSpeak(text, voice) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-edge-"));
    const out = path.join(dir, "s.mp3");
    try {
        await pexec(
            "edge-tts",
            ["--voice", voice, "--text", String(text).slice(0, 4000), "--write-media", out],
            { timeout: 60000, windowsHide: true }
        );
        return { audio: fs.readFileSync(out), contentType: "audio/mpeg" };
    }
    finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ }
    }
}

/**
 * Layanan suara sisi-daemon: STT (suara masuk) dan TTS neural
 * (suara keluar berkualitas).
 *
 * Keduanya memakai backend kompatibel-OpenAI yang bisa diatur dari
 * Settings (seperti skema API key):
 *   - STT  : /v1/audio/transcriptions (faster-whisper-server, dll)
 *   - TTS  : /v1/audio/speech (Kokoro-FastAPI, OpenAI, dll) —
 *            memberi banyak suara & dukungan bahasa Indonesia.
 *
 * Semua opsional & degradasinya anggun: tanpa STT, mic melapor
 * belum siap; tanpa TTS neural, Console jatuh ke suara OS
 * (speechSynthesis). Rahasia disimpan di configs/voice.json
 * (gitignored) dan dimasking saat ditampilkan.
 */
const store = new JsonStore(
    path.join(__dirname, "..", "..", "configs", "voice.json"),
    { stt: {}, tts: {} }
);

/**
 * Normalisasi nama voice dari renderer.
 * - null / kosong → if_sara
 * - pola Kokoro (^[a-z]{2}_[a-z0-9]+$) → pakai adanya
 * - pola edge-tts (^[a-z]{2}-[A-Z]{2}-.+$) atau mengandung
 *   ardi/gadis/microsoft/online/natural (case-insensitive) → if_sara
 */
function normalizeVoice(voice) {
    const v = (voice ?? "").trim();
    if (!v) return "if_sara";
    if (/^[a-z]{2}_[a-z0-9]+$/.test(v)) return v;
    if (/^[a-z]{2}-[A-Z]{2}-.+$/i.test(v)) return "if_sara";
    if (/ardi|gadis|microsoft|online|natural/i.test(v)) return "if_sara";
    return "if_sara";
}

class VoiceService {

    constructor() {

        this.lastError = null;

    }

    // Setelan tersimpan menang atas .env.
    cfg() {
        return store.read();
    }

    get sttUrl() {
        return this.cfg().stt?.url || process.env.AETHER_STT_URL || null;
    }
    get sttModel() {
        return this.cfg().stt?.model || process.env.AETHER_STT_MODEL || "Systran/faster-whisper-base";
    }
    get sttKey() {
        return this.cfg().stt?.key || process.env.AETHER_STT_KEY || null;
    }
    get sttConfigured() {
        return Boolean(this.sttUrl);
    }

    get ttsUrl() {
        return this.cfg().tts?.url || process.env.AETHER_TTS_URL || null;
    }
    get ttsModel() {
        return this.cfg().tts?.model || process.env.AETHER_TTS_MODEL || "kokoro";
    }
    get ttsVoice() {
        return this.cfg().tts?.voice || process.env.AETHER_TTS_VOICE || "af_heart";
    }
    get ttsKey() {
        return this.cfg().tts?.key || process.env.AETHER_TTS_KEY || null;
    }
    get ttsConfigured() {
        return Boolean(this.ttsUrl);
    }

    /** Simpan setelan dari Settings (key dibiarkan bila tak dikirim). */
    setConfig({ stt, tts } = {}) {

        const current = this.cfg();

        const merge = (base, patch) => {
            if (!patch) return base;
            return {
                url: patch.url !== undefined ? (patch.url || null) : base.url ?? null,
                model: patch.model !== undefined ? (patch.model || null) : base.model ?? null,
                voice: patch.voice !== undefined ? (patch.voice || null) : base.voice ?? null,
                // key undefined = jangan ubah; "" = hapus.
                key: patch.key === undefined ? (base.key ?? null) : (patch.key || null)
            };
        };

        store.write({
            stt: merge(current.stt ?? {}, stt),
            tts: merge(current.tts ?? {}, tts)
        });

        return this.configView();

    }

    mask(key) {
        if (!key) return null;
        const s = String(key);
        return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
    }

    /** Untuk Settings: key dimasking. */
    configView() {

        const c = this.cfg();

        return {
            stt: {
                url: c.stt?.url ?? "",
                model: c.stt?.model ?? "",
                hasKey: Boolean(c.stt?.key),
                keyHint: this.mask(c.stt?.key),
                configured: this.sttConfigured
            },
            tts: {
                url: c.tts?.url ?? "",
                model: c.tts?.model ?? "",
                voice: c.tts?.voice ?? "",
                hasKey: Boolean(c.tts?.key),
                keyHint: this.mask(c.tts?.key),
                configured: this.ttsConfigured
            }
        };

    }

    /**
     * Apakah sebuah backend suara benar-benar menjawab.
     *
     * "Terkonfigurasi" hanya berarti URL-nya tertulis di berkas; ia
     * tidak mengatakan apa pun soal apakah servisnya hidup. Selama ini
     * status hanya melaporkan yang pertama, jadi Console menampilkan
     * suara sebagai siap sementara setiap panggilan gagal — pemilik
     * lalu mengira konfigurasinya yang salah dan menyetelnya
     * berulang-ulang. Hasil probe di-cache singkat supaya polling
     * Console tidak membebani.
     */
    async reachable(url) {

        if (!url) return false;

        const now = Date.now();
        this._probe ??= new Map();

        const cached = this._probe.get(url);
        if (cached && now - cached.at < 15000) return cached.ok;

        let ok = false;

        try {
            const base = new URL(url);
            const res = await fetch(`${base.origin}/v1/models`, {
                signal: AbortSignal.timeout(2500)
            });
            // Servis yang hidup boleh menolak (401/404); yang penting
            // ada yang menjawab di ujung sana.
            ok = res.status > 0;
        }
        catch {
            ok = false;
        }

        this._probe.set(url, { at: now, ok });
        return ok;

    }

    /**
     * Daftar suara dari container TTS neural.
     *
     * Console sebelumnya hanya menampilkan suara OS (speechSynthesis),
     * jadi container neural yang sudah dipasang tak pernah muncul.
     * Endpoint OpenAI-compatible menyajikannya di /v1/audio/voices —
     * Kokoro punya, sebagian (Piper/openedai-speech) tidak. Bila tak
     * ada, suara yang sedang dikonfigurasi tetap dikembalikan supaya
     * daftar tak pernah benar-benar kosong.
     */
    async voices() {

        if (!this.ttsConfigured) {
            return { source: "none", voices: [] };
        }

        // /v1/audio/speech → origin + /v1/audio/voices.
        let base;
        try { base = new URL(this.ttsUrl).origin; }
        catch { return { source: "invalid-url", voices: [] }; }

        const headers = {};
        if (this.ttsKey) headers.Authorization = `Bearer ${this.ttsKey}`;

        try {
            const res = await fetch(`${base}/v1/audio/voices`, {
                headers, signal: AbortSignal.timeout(5000)
            });

            if (res.ok) {
                const data = await res.json().catch(() => null);
                const list = Array.isArray(data?.voices) ? data.voices
                    : Array.isArray(data) ? data : [];
                const voices = list
                    .map(v => (typeof v === "string" ? { id: v, name: v } : { id: v.id ?? v.name, name: v.name ?? v.id }))
                    .filter(v => v.id);
                // Suara Ardi (edge-tts, buatan Aether) selalu ikut di paling
                // atas — disintesis di daemon, bukan dari container Kokoro.
                voices.unshift({ id: "id-ID-ArdiNeural", name: "Ardi (edge-tts, ID pria)" });
                if (voices.length) {
                    return { source: "neural", url: base, current: this.ttsVoice, voices };
                }
            }
        }
        catch { /* endpoint tak ada / mati → fallback di bawah */ }

        // Container tanpa daftar (Piper): setidaknya tampilkan yang aktif.
        return {
            source: "configured",
            url: base,
            current: this.ttsVoice,
            voices: this.ttsVoice ? [{ id: this.ttsVoice, name: this.ttsVoice }] : []
        };

    }

    async status() {

        const [sttOnline, ttsOnline] = await Promise.all([
            this.sttConfigured ? this.reachable(this.sttUrl) : Promise.resolve(false),
            this.ttsConfigured ? this.reachable(this.ttsUrl) : Promise.resolve(false)
        ]);

        const mati = [];
        if (this.sttConfigured && !sttOnline) mati.push("STT");
        if (this.ttsConfigured && !ttsOnline) mati.push("TTS");

        return {
            stt: {
                configured: this.sttConfigured,
                online: sttOnline,
                url: this.sttUrl,
                model: this.sttModel,
                lastError: this.lastError
            },
            tts: {
                // Neural bila dikonfigurasi DAN hidup; kalau tidak,
                // renderer memakai suara OS (speechSynthesis).
                neural: this.ttsConfigured && ttsOnline,
                configured: this.ttsConfigured,
                online: ttsOnline,
                url: this.ttsUrl,
                model: this.ttsModel,
                voice: this.ttsVoice,
                engine: (this.ttsConfigured && ttsOnline)
                    ? "neural (OpenAI-compatible)"
                    : "speechSynthesis (OS)"
            },
            hint: mati.length
                ? `${mati.join(" & ")} terkonfigurasi tetapi servisnya tidak menjawab. ` +
                  "Jalankan: docker compose -f deploy/voice/docker-compose.yml up -d"
                : null
        };

    }

    /**
     * Hasilkan audio ucapan dari teks lewat backend TTS neural.
     * @returns {Promise<{ audio: Buffer, contentType: string }>}
     */
    async speak(text, { voice = null, format = "mp3" } = {}) {

        // Suara ARDI (edge-tts) — jalur terpisah, tak butuh Kokoro. Bila
        // gagal (edge-tts tak ada dsb), jatuh ke TTS neural di bawah.
        const edgeVoice = resolveEdge(voice || this.ttsVoice);
        if (edgeVoice) {
            try {
                const out = await edgeSpeak(text, edgeVoice);
                telemetry.publish("voice:spoken", { chars: text.length, voice: edgeVoice });
                return out;
            }
            catch (error) {
                telemetry.warn(`[voice] edge-tts (${edgeVoice}) gagal: ${error.message}`);
                if (!this.ttsConfigured) throw error;
            }
        }

        if (!this.ttsConfigured) {
            const error = new Error(
                "TTS neural belum dikonfigurasi. Set endpoint /v1/audio/speech " +
                "(mis. Kokoro-FastAPI) di Settings, atau pakai suara OS."
            );
            error.code = "TTS_NOT_CONFIGURED";
            throw error;
        }

        const headers = { "Content-Type": "application/json" };
        if (this.ttsKey) {
            headers.Authorization = `Bearer ${this.ttsKey}`;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);

        try {

            const raw = voice || this.ttsVoice;
            let resolvedVoice = this.ttsVoice;
            if (raw && /^[a-z]{2}_[a-z0-9]+$/i.test(raw)) {
                resolvedVoice = raw;
            } else {
                try {
                    const base = new URL(this.ttsUrl).origin;
                    const h = {};
                    if (this.ttsKey) h.Authorization = `Bearer ${this.ttsKey}`;
                    const r = await fetch(`${base}/v1/audio/voices`, {
                        headers: h, signal: AbortSignal.timeout(3000)
                    });
                    if (r.ok) {
                        const d = await r.json().catch(() => null);
                        const list = Array.isArray(d?.voices) ? d.voices
                            : Array.isArray(d) ? d : [];
                        const ids = list.map(v =>
                            typeof v === "string" ? v : (v.id ?? v.name)
                        ).filter(Boolean);
                        if (ids.includes(raw)) resolvedVoice = raw;
                    }
                } catch { /* ignore – fallback to config */ }
            }

            const response = await fetch(this.ttsUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: this.ttsModel,
                    input: text,
                    voice: resolvedVoice,
                    response_format: format
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                throw new Error(`Backend TTS menolak (${response.status}): ${detail.slice(0, 200)}`);
            }

            const audio = Buffer.from(await response.arrayBuffer());

            telemetry.publish("voice:spoken", { chars: text.length, voice: voice || this.ttsVoice });

            return {
                audio,
                contentType: response.headers.get("content-type") || `audio/${format}`
            };

        }

        catch (error) {
            if (error.name === "AbortError") {
                throw new Error("TTS melebihi batas waktu.");
            }
            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa menghubungi backend TTS di ${this.ttsUrl}`);
            }
            throw error;
        }

        finally {
            clearTimeout(timer);
        }

    }

    /**
     * Transkripsi audio menjadi teks.
     *
     * @param {Buffer} audio  data audio mentah (webm/ogg/wav)
     * @param {object} opts
     * @param {string} opts.mimeType
     * @param {string} [opts.language]  kode ISO, mis. "id"
     * @returns {Promise<{ text: string }>}
     */
    async transcribe(audio, { mimeType = "audio/webm", language = "id" } = {}) {

        if (!this.sttConfigured) {

            const error = new Error(
                "STT belum dikonfigurasi. Set AETHER_STT_URL ke endpoint transcribe " +
                "kompatibel-OpenAI (mis. faster-whisper-server) di mesin daemon."
            );

            error.code = "STT_NOT_CONFIGURED";

            throw error;

        }

        if (!audio || audio.length === 0) {
            throw new Error("Audio kosong.");
        }

        const extension = extensionFor(mimeType);

        const form = new FormData();

        form.append(
            "file",
            new Blob([audio], { type: mimeType }),
            `speech.${extension}`
        );

        form.append("model", this.sttModel);

        if (language) {
            form.append("language", language);
        }

        // Format teks polos paling sederhana untuk diparse.
        form.append("response_format", "json");

        const headers = {};

        if (this.sttKey) {
            headers.Authorization = `Bearer ${this.sttKey}`;
        }

        const controller = new AbortController();

        const timer = setTimeout(() => controller.abort(), 60000);

        try {

            const response = await fetch(this.sttUrl, {
                method: "POST",
                headers,
                body: form,
                signal: controller.signal
            });

            if (!response.ok) {

                const detail = await response.text().catch(() => "");

                throw new Error(
                    `Backend STT menolak (${response.status}): ${detail.slice(0, 200)}`
                );

            }

            const data = await response.json().catch(() => null);

            const text = (data?.text ?? "").trim();

            this.lastError = null;

            telemetry.publish("voice:transcribed", {
                chars: text.length,
                language
            });

            return { text };

        }

        catch (error) {

            this.lastError =
                error.name === "AbortError"
                    ? "transcribe melebihi batas waktu"
                    : error.message;

            if (error.name === "AbortError") {
                throw new Error("Transkripsi melebihi batas waktu.");
            }

            if (error instanceof TypeError) {
                throw new Error(`Tidak bisa menghubungi backend STT di ${this.sttUrl}`);
            }

            throw error;

        }

        finally {
            clearTimeout(timer);
        }

    }

}

function extensionFor(mimeType) {

    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";

    return "webm";

}

module.exports = new VoiceService();
module.exports.normalizeVoice = normalizeVoice;
