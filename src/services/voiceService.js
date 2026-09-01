const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const telemetry = require("./telemetryService");
const JsonStore = require("../core/config/JsonStore");

const pexec = promisify(execFile);

/**
 * Suara ARDI (buatan Damar) memakai edge-tts (Microsoft Neural,
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

function isLocalEndpoint(value) {
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") &&
            (url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
                url.hostname === "::1" || url.hostname === "[::1]");
    }
    catch {
        return false;
    }
}

async function edgeSpeak(text, voice) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-edge-"));
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
        this.lastEngine = null;
        this.lastTtsError = null;

    }

    // Setelan tersimpan menang atas .env.
    cfg() {
        return store.read();
    }

    get sttUrl() {
        return this.cfg().stt?.url || process.env.DAMAR_STT_URL || null;
    }
    get sttModel() {
        return this.cfg().stt?.model || process.env.DAMAR_STT_MODEL || "Systran/faster-whisper-base";
    }
    get sttKey() {
        return this.cfg().stt?.key || process.env.DAMAR_STT_KEY || null;
    }
    get sttConfigured() {
        return Boolean(this.sttUrl);
    }

    get ttsUrl() {
        return this.cfg().tts?.url || process.env.DAMAR_TTS_URL || null;
    }
    get ttsModel() {
        return this.cfg().tts?.model || process.env.DAMAR_TTS_MODEL || "kokoro";
    }
    get ttsVoice() {
        return this.cfg().tts?.voice || process.env.DAMAR_TTS_VOICE || "af_heart";
    }
    get ttsKey() {
        return this.cfg().tts?.key || process.env.DAMAR_TTS_KEY || null;
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
                // Suara Ardi (edge-tts, buatan Damar) selalu ikut di paling
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
            lastEngine: this.lastEngine,
            lastTtsError: this.lastTtsError,
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
    /**
     * Hasilkan audio ucapan dengan RANTAI MESIN (jujur soal yang dipakai):
     *   1. edge-tts (suara diminta/konfigurasi)
     *   2. TTS neural kompatibel-OpenAI (Kokoro dll)
     *   3. edge-tts fallback id-ID-ArdiNeural
     * Semua gagal → error gabungan penyebab tiap mesin. TIDAK ada fallback
     * diam-diam ke suara OS di sisi daemon.
     */
    async speak(text, { voice = null, format = "mp3", localOnly = false, signal = null } = {}) {

        const attempts = [];

        const edgeVoice = resolveEdge(voice || this.ttsVoice);

        if (edgeVoice && !localOnly) {
            try {
                const out = await edgeSpeak(text, edgeVoice);
                this.lastEngine = "edge";
                telemetry.publish("voice:spoken", { chars: text.length, voice: edgeVoice, engine: "edge" });
                return { audio: out.audio, contentType: out.contentType, engine: "edge" };
            }
            catch (error) {
                attempts.push(`edge(${edgeVoice}): ${error.message}`);
                telemetry.warn(`[voice] edge-tts gagal: ${error.message}`);
            }
        }

        if (this.ttsConfigured && (!localOnly || isLocalEndpoint(this.ttsUrl))) {

            let timer = null;
            let onAbort = null;
            try {

                const headers = { "Content-Type": "application/json" };
                if (this.ttsKey) headers.Authorization = `Bearer ${this.ttsKey}`;

                const controller = new AbortController();
                timer = setTimeout(() => controller.abort(), 60000);
                onAbort = signal ? () => controller.abort() : null;
                if (onAbort) signal.addEventListener("abort", onAbort, { once: true });

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
                                typeof v === "string" ? v : (v.id ?? v.name));
                            if (ids.includes(raw)) resolvedVoice = raw;
                        }
                    } catch { /* pakai config */ }
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
                    throw new Error(`menolak (${response.status}): ${detail.slice(0, 120)}`);
                }

                const audio = Buffer.from(await response.arrayBuffer());
                this.lastEngine = "neural";

                telemetry.publish("voice:spoken", {
                    chars: text.length, voice: resolvedVoice, engine: "neural"
                });

                return {
                    audio,
                    contentType: response.headers.get("content-type") || `audio/${format}`,
                    engine: "neural"
                };

            }
            catch (error) {
                const msg = error.name === "AbortError" ? "timeout" : error.message;
                attempts.push(`neural(${this.ttsUrl}): ${msg}`);
                telemetry.warn(`[voice] neural TTS gagal: ${msg}`);
            }
            finally {
                clearTimeout(timer);
                if (onAbort) signal.removeEventListener("abort", onAbort);
            }

        }

        if (!localOnly && edgeVoice !== "id-ID-ArdiNeural") {
            try {
                const out = await edgeSpeak(text, "id-ID-ArdiNeural");
                this.lastEngine = "edge-fallback";
                telemetry.publish("voice:spoken", {
                    chars: text.length, voice: "id-ID-ArdiNeural", engine: "edge-fallback"
                });
                return { audio: out.audio, contentType: out.contentType, engine: "edge-fallback" };
            }
            catch (error) {
                attempts.push("edge(Ardi): " + error.message);
            }
        }

        this.lastEngine = null;
        this.lastTtsError = attempts.join(" | ");

        const err = new Error(
            "Semua mesin TTS gagal → " +
            (attempts.join(" | ") || "tidak ada yang dikonfigurasi") +
            ". Pasang CLI edge-tts atau nyalakan backend neural."
        );
        err.code = "TTS_ALL_FAILED";
        throw err;

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
    async transcribe(audio, { mimeType = "audio/webm", language = "id", localOnly = false, signal = null } = {}) {

        if (!this.sttConfigured) {

            const error = new Error(
                "STT belum dikonfigurasi. Set DAMAR_STT_URL ke endpoint transcribe " +
                "kompatibel-OpenAI (mis. faster-whisper-server) di mesin daemon."
            );

            error.code = "STT_NOT_CONFIGURED";

            throw error;

        }

        if (localOnly && !isLocalEndpoint(this.sttUrl)) {
            const error = new Error("Canonical voice STT requires a local endpoint.");
            error.code = "STT_LOCAL_REQUIRED";
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
        const onAbort = signal ? () => controller.abort() : null;
        if (onAbort) signal.addEventListener("abort", onAbort, { once: true });

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
            if (onAbort) signal.removeEventListener("abort", onAbort);
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
