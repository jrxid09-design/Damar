"use strict";

/**
 * engines — pembungkus tipis binary lokal voice Damar:
 *   - STT: whisper.cpp (whisper-cli) + model ggml dari HuggingFace
 *     (ggerganov/whisper.cpp) — quantized, CPU-first.
 *   - TTS: Piper (rhasspy/piper) + suara id_ID (news_tts)
 *   - TTS: Supertonic 3 (Supertone/supertonic-3) — suara id_ID pria M1-M5 /
 *     wanita F1-F5, ONNX, CPU (default sejak 2026-11-25; Piper jadi alternatif). — ONNX, CPU.
 *
 * Semua proses dijalankan dengan execFile + argv tetap (tanpa shell, tanpa
 * interpolasi string pemanggil ke perintah). Berkas model & binary tinggal
 * di data/voice/ (gitignored, per-instalasi) — unduh lewat
 * scripts/voice-setup.ps1. Modul ini TIDAK mengunduh apa pun.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const pexec = promisify(execFile);

/** Akar instalasi voice lokal (per mesin). */
function voiceLocalRoot() {
    if (process.env.DAMAR_VOICE_LOCAL_DIR) return process.env.DAMAR_VOICE_LOCAL_DIR;
    return path.join(__dirname, "..", "..", "..", "data", "voice");
}

function findFile(root, name, maxDepth = 3) {
    if (!root || !fs.existsSync(root)) return null;
    const direct = path.join(root, name);
    if (fs.existsSync(direct)) return direct;
    if (maxDepth <= 0) return null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const hit = findFile(path.join(root, entry.name), name, maxDepth - 1);
            if (hit) return hit;
        }
    }
    return null;
}

function whisperBin(root = voiceLocalRoot()) {
    return findFile(path.join(root, "bin", "whisper"), process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

function piperBin(root = voiceLocalRoot()) {
    return findFile(path.join(root, "bin", "piper"), process.platform === "win32" ? "piper.exe" : "piper");
}

/** Supertonic 3 — TTS lokal (ONNX, CPU) dgn 10 preset multi-bahasa. */
const SUPERTONIC_VOICES = Object.freeze(["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]);
const SUPERTONIC_PORT_DEFAULT = 8128;
const SUPERTONIC_MODEL = "supertonic-3";

function supertonicModelDir(root = voiceLocalRoot()) {
    return path.join(root, "supertonic3");
}

/** "supertonic-M1" -> true bila preset Supertonic yang dikenal. */
function isSupertonicVoice(voice) {
    const v = String(voice ?? "").trim();
    return /^supertonic-[MF][1-5]$/i.test(v);
}

/** "supertonic-M1" -> "M1" (null bila bukan suara Supertonic). */
function supertonicPreset(voice) {
    if (!isSupertonicVoice(voice)) return null;
    return String(voice).trim().slice("supertonic-".length).toUpperCase();
}

function supertonicPython(root = voiceLocalRoot()) {
    const cands = process.platform === "win32"
        ? [path.join(root, "pyenv", "Scripts", "python.exe")]
        : [path.join(root, "pyenv", "bin", "python")];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return null;
}

function listSupertonicVoices(root = voiceLocalRoot()) {
    const dir = supertonicModelDir(root);
    // Model dianggap terpasang bila berkas ONNX terbesarnya ada.
    if (!fs.existsSync(path.join(dir, "onnx", "vector_estimator.onnx"))) return [];
    return SUPERTONIC_VOICES.map(p => ({
        id: `supertonic-${p}`,
        preset: p,
        gender: p.startsWith("M") ? "male" : "female",
        engine: SUPERTONIC_MODEL,
        name: `${p} (Supertonic 3, lokal, ${p.startsWith("M") ? "pria" : "wanita"})`
    }));
}

/** Peta nama model ramah → berkas ggml di models/. */
const WHISPER_MODEL_FILES = Object.freeze({
    "tiny": "ggml-tiny.bin",
    "ggml-tiny": "ggml-tiny.bin",
    "base": "ggml-base.bin",
    "ggml-base": "ggml-base.bin",
    "systran/faster-whisper-base": "ggml-base.bin",
    "small": "ggml-small.bin",
    "ggml-small": "ggml-small.bin",
    "systran/faster-whisper-small": "ggml-small.bin",
    "medium": "ggml-medium-q5_0.bin",
    "ggml-medium": "ggml-medium-q5_0.bin",
    "medium-q5_0": "ggml-medium-q5_0.bin",
    "ggml-medium-q5_0": "ggml-medium-q5_0.bin",
    "large-v3-turbo": "ggml-large-v3-turbo-q5_0.bin",
    "turbo": "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3-turbo-q5_0": "ggml-large-v3-turbo-q5_0.bin"
});

function resolveWhisperModel(name, root = voiceLocalRoot()) {
    const modelsDir = path.join(root, "models");
    const key = String(name ?? "").trim().toLowerCase();
    if (key.endsWith(".bin")) {
        const p = path.join(modelsDir, path.basename(key));
        return fs.existsSync(p) ? p : null;
    }
    const file = WHISPER_MODEL_FILES[key];
    if (file) {
        const p = path.join(modelsDir, file);
        if (fs.existsSync(p)) return p;
    }
    // Nama tak dikenal: coba pola ggml-<nama>.bin.
    const guess = path.join(modelsDir, `ggml-${key}.bin`);
    return fs.existsSync(guess) ? guess : null;
}

function listWhisperModels(root = voiceLocalRoot()) {
    const dir = path.join(root, "models");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => /^ggml-.*\.bin$/i.test(f))
        .map(f => ({ id: f.replace(/\.bin$/i, ""), file: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

function resolvePiperVoice(voice, root = voiceLocalRoot()) {
    const dir = path.join(root, "voices");
    const name = String(voice ?? "id_ID-news_tts-medium").trim();
    const onnx = path.join(dir, name.endsWith(".onnx") ? name : `${name}.onnx`);
    if (!fs.existsSync(onnx)) return null;
    return { onnx, config: `${onnx}.json`, id: path.basename(onnx, ".onnx") };
}

function listPiperVoices(root = voiceLocalRoot()) {
    const dir = path.join(root, "voices");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith(".onnx"))
        .map(f => ({ id: f.replace(/\.onnx$/i, ""), file: f, bytes: fs.statSync(path.join(dir, f)).size }));
}

/** Status kesiapan mesin lokal (untuk /health & status daemon). */
function probe(root = voiceLocalRoot()) {
    const w = whisperBin(root);
    const p = piperBin(root);
    return {
        root,
        whisper: { bin: w, ok: Boolean(w), models: listWhisperModels(root) },
        piper: { bin: p, ok: Boolean(p), voices: listPiperVoices(root) },
        supertonic: { ok: listSupertonicVoices(root).length > 0, modelDir: supertonicModelDir(root), voices: listSupertonicVoices(root) }
    };
}

function tmpWav(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `damar-voice-${tag}-`));
    return { dir, file: path.join(dir, "audio.wav"), cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ } } };
}

/**
 * Transkripsi WAV → teks memakai whisper.cpp.
 * @param {Buffer} wavBuffer audio WAV (16 kHz mono disarankan; whisper
 *        menangani laju lain lewat resample internal ffmpeg-nya sendiri —
 *        di sini pemanggil memberi WAV apa adanya).
 * @returns {Promise<{ text: string, ms: number }>}
 */
async function transcribeWav(wavBuffer, {
    model = "ggml-tiny", language = "id", threads = Math.min(8, os.cpus().length),
    prompt = null, root = voiceLocalRoot(), timeoutMs = 180000
} = {}) {
    const bin = whisperBin(root);
    if (!bin) throw new Error("whisper-cli tidak ditemukan — jalankan scripts/voice-setup.ps1 dulu");
    const modelFile = resolveWhisperModel(model, root);
    if (!modelFile) throw new Error(`model whisper '${model}' tidak ada di ${path.join(root, "models")}`);

    const tmp = tmpWav("stt");
    try {
        fs.writeFileSync(tmp.file, wavBuffer);
        const args = ["-m", modelFile, "-f", tmp.file, "-l", language, "-t", String(threads), "-nt", "-np"];
        if (prompt) args.push("--prompt", String(prompt));
        const t0 = Date.now();
        const { stdout } = await pexec(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        const text = String(stdout).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
        return { text, ms: Date.now() - t0 };
    } finally {
        tmp.cleanup();
    }
}

/**
 * Sintesis teks → WAV memakai Piper (suara Indonesia).
 * @returns {Promise<{ audio: Buffer, ms: number, voice: string }>}
 */
async function synthesize(text, {
    voice = "id_ID-news_tts-medium", lengthScale = 1.0, sentenceSilence = 0.1,
    root = voiceLocalRoot(), timeoutMs = 120000
} = {}) {
    // Suara Supertonic ("supertonic-M1".."supertonic-F5") -> service Python
    // resident; Piper tetap jalur suara "id_ID-*". Default parameter di sini
    // sengaja tetap Piper: default PRODUKSI diatur di configs/voice.json +
    // server.js; pemanggil pustaka tanpa suara tidak berubah perilaku.
    if (isSupertonicVoice(voice)) return synthesizeSupertonic(text, { voice, root, timeoutMs });
    const bin = piperBin(root);
    if (!bin) throw new Error("piper tidak ditemukan — jalankan scripts/voice-setup.ps1 dulu");
    const v = resolvePiperVoice(voice, root);
    if (!v) throw new Error(`suara piper '${voice}' tidak ada di ${path.join(root, "voices")}`);

    const tmp = tmpWav("tts");
    try {
        const args = ["--model", v.onnx, "--output_file", tmp.file,
            "--length_scale", String(lengthScale), "--sentence_silence", String(sentenceSilence)];
        if (fs.existsSync(v.config)) args.push("--config", v.config);
        const t0 = Date.now();
        // spawn + stdin manual: opsi `input` milik execFile TIDAK pernah
        // mengantarkan EOF ke Piper di Windows (terbukti menggantung);
        // pola spawn/write/end selesai dalam ~0,4 dtk untuk 1 kalimat.
        await new Promise((resolve, reject) => {
            const child = spawn(bin, args, { windowsHide: true });
            let stderr = "";
            const killer = setTimeout(() => {
                child.kill();
                reject(new Error(`piper timeout setelah ${timeoutMs} ms`));
            }, timeoutMs);
            child.stderr.on("data", d => { stderr += d; });
            child.on("error", err => { clearTimeout(killer); reject(err); });
            child.on("close", code => {
                clearTimeout(killer);
                if (code === 0) resolve();
                else reject(new Error(`piper keluar dengan kode ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
            });
            child.stdin.write(String(text));
            child.stdin.end();
        });
        const audio = fs.readFileSync(tmp.file);
        return { audio, ms: Date.now() - t0, voice: v.id };
    } finally {
        tmp.cleanup();
    }
}

/**
 * WarmWhisperServer — whisper-server.exe yang RESIDENT: model dimuat
 * sekali saat start (cold-load diukur terpisah sebagai loadMs) lalu
 * melayani banyak transkripsi tanpa memuat ulang. Inilah pola "model
 * selalu hangat di memori" untuk jalur percakapan; transcribeWav (CLI)
 * tetap ada sebagai fallback dingin.
 */
class WarmWhisperServer {

    constructor({ model = "ggml-small", port = 8181, threads = Math.min(8, os.cpus().length), root = voiceLocalRoot() } = {}) {
        this.model = model;
        this.port = port;
        this.threads = threads;
        this.root = root;
        this.proc = null;
        this.loadMs = null;
        this.ok = false;
        this.lastError = null;
    }

    async start({ warmup = true } = {}) {
        if (this.proc) return this;
        const bin = findFile(path.join(this.root, "bin", "whisper"),
            process.platform === "win32" ? "whisper-server.exe" : "whisper-server");
        if (!bin) throw new Error("whisper-server tidak ditemukan — jalankan scripts/voice-setup.ps1 dulu");
        const modelFile = resolveWhisperModel(this.model, this.root);
        if (!modelFile) throw new Error(`model whisper '${this.model}' tidak ada`);

        const { spawn } = require("node:child_process");
        const t0 = Date.now();
        this.proc = spawn(bin, ["-m", modelFile, "--host", "127.0.0.1", "--port", String(this.port),
            "-t", String(this.threads), "-l", "id"], { windowsHide: true, stdio: "ignore" });
        this.proc.on("exit", () => { this.ok = false; this.proc = null; });
        this.proc.on("error", err => { this.lastError = err.message; this.ok = false; });

        // Tunggu sampai HTTP menjawab (model selesai dimuat sebelum listen).
        const deadline = Date.now() + 120000;
        for (;;) {
            try {
                const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1500) });
                if (res.status > 0) break;
            } catch { /* belum siap */ }
            if (Date.now() > deadline) throw new Error("whisper-server tidak siap dalam 120 dtk");
            await new Promise(r => setTimeout(r, 250));
        }
        this.loadMs = Date.now() - t0;
        this.ok = true;

        if (warmup) {
            // Satu inferensi pemanasan (hening 0,5 dtk) agar jalur benar-benar panas.
            try { await this.transcribe(silenceWav(500), { language: "id" }); } catch { /* abaikan */ }
        }
        return this;
    }

    async transcribe(wavBuffer, { language = "id" } = {}) {
        if (!this.ok) throw new Error("whisper-server belum jalan");
        const form = new FormData();
        form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
        form.append("response_format", "json");
        form.append("language", language);
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
            method: "POST", body: form, signal: AbortSignal.timeout(180000)
        });
        if (!res.ok) throw new Error(`whisper-server menolak (${res.status})`);
        const data = await res.json().catch(() => null);
        const text = String(data?.text ?? "").replace(/\s+/g, " ").trim();
        return { text, ms: Date.now() - t0 };
    }

    stop() {
        if (this.proc) { try { this.proc.kill(); } catch { /* abaikan */ } this.proc = null; }
        this.ok = false;
        return this;
    }

    status() {
        return { model: this.model, port: this.port, ok: this.ok, loadMs: this.loadMs, lastError: this.lastError };
    }
}

/**
 * WarmSupertonicServer — service TTS Supertonic yang RESIDENT (pola
 * WarmWhisperServer): model dimuat sekali saat start, lalu melayani
 * banyak sintesis tanpa muat ulang. Service-nya = skrip Python
 * src/voice/local/supertonic_service.py (stdlib http.server + paket
 * `supertonic`), dijalankan python venv data/voice/pyenv.
 */
class WarmSupertonicServer {

    constructor({ port = Number(process.env.DAMAR_SUPERTONIC_PORT || SUPERTONIC_PORT_DEFAULT), root = voiceLocalRoot() } = {}) {
        this.port = port;
        this.root = root;
        this.proc = null;
        this.loadMs = null;
        this.ok = false;
        this.lastError = null;
        this._starting = null;
    }

    async start({ warmup = true } = {}) {
        if (this.proc) return this;
        if (this._starting) return this._starting;
        this._starting = (async () => {
            const py = supertonicPython(this.root);
            if (!py) throw new Error("python venv supertonic tidak ditemukan \u2014 jalankan scripts/voice-setup.ps1 dulu");
            const script = path.join(__dirname, "supertonic_service.py");
            if (!fs.existsSync(script)) throw new Error("supertonic_service.py tidak ditemukan di src/voice/local");
            const modelDir = supertonicModelDir(this.root);
            if (!fs.existsSync(path.join(modelDir, "onnx", "vector_estimator.onnx"))) throw new Error("model Supertonic 3 tidak ada di data/voice/supertonic3 \u2014 jalankan scripts/voice-setup.ps1 dulu");
            const t0 = Date.now();
            this.proc = spawn(py, [script, modelDir, String(this.port)], { windowsHide: true, stdio: "ignore" });
            this.proc.on("exit", () => { this.ok = false; this.proc = null; });
            this.proc.on("error", err => { this.lastError = err.message; this.ok = false; });
            const deadline = Date.now() + 120000;
            for (;;) {
                try {
                    const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
                    if (res.ok) break;
                } catch { /* belum siap */ }
                if (Date.now() > deadline) throw new Error("supertonic service tidak siap dalam 120 dtk");
                await new Promise(r => setTimeout(r, 250));
            }
            this.loadMs = Date.now() - t0;
            this.ok = true;
            if (warmup) {
                try { await this.synthesize("Damar.", { voice: "supertonic-M1" }); } catch { /* abaikan */ }
            }
            return this;
        })();
        try { return await this._starting; }
        finally { this._starting = null; }
    }

    async synthesize(text, { voice = "supertonic-M1", steps = 5, timeoutMs = 120000 } = {}) {
        if (!this.ok) throw new Error("supertonic service belum jalan");
        const preset = supertonicPreset(voice) || "M1";
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${this.port}/synthesize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: String(text), voice: preset, steps, lang: "id" }),
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`supertonic menolak (${res.status}): ${detail.slice(0, 200)}`);
        }
        const audio = Buffer.from(await res.arrayBuffer());
        return { audio, ms: Date.now() - t0, voice: `supertonic-${preset}` };
    }

    stop() {
        if (this.proc) { try { this.proc.kill(); } catch { /* abaikan */ } this.proc = null; }
        this.ok = false;
        return this;
    }

    status() {
        return { model: SUPERTONIC_MODEL, port: this.port, ok: this.ok, loadMs: this.loadMs, lastError: this.lastError };
    }
}

const supertonicServers = new Map();

async function ensureSupertonicServer(root = voiceLocalRoot()) {
    const key = path.resolve(root);
    let server = supertonicServers.get(key);
    if (server && server.ok) return server;
    if (!server) { server = new WarmSupertonicServer({ root }); supertonicServers.set(key, server); }
    await server.start();
    return server;
}

async function synthesizeSupertonic(text, { voice, root = voiceLocalRoot(), timeoutMs = 120000 } = {}) {
    const server = await ensureSupertonicServer(root);
    return server.synthesize(text, { voice, timeoutMs });
}

/** Matikan semua service Supertonic resident (dipakai server.js close()). */
function stopSupertonicServers() {
    for (const server of supertonicServers.values()) server.stop();
    supertonicServers.clear();
}

/** WAV hening (untuk pemanasan / tes). */
function silenceWav(ms = 500, sampleRate = 16000) {
    const n = Math.floor((sampleRate * ms) / 1000);
    const data = Buffer.alloc(n * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8, "latin1");
    header.write("fmt ", 12, "latin1");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "latin1");
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

module.exports = {
    voiceLocalRoot, whisperBin, piperBin,
    resolveWhisperModel, listWhisperModels,
    resolvePiperVoice, listPiperVoices,
    probe, transcribeWav, synthesize,
    WarmWhisperServer, WarmSupertonicServer, silenceWav,
    isSupertonicVoice, supertonicPreset, listSupertonicVoices, supertonicModelDir, stopSupertonicServers,
    SUPERTONIC_VOICES, SUPERTONIC_MODEL, SUPERTONIC_PORT_DEFAULT,
    WHISPER_MODEL_FILES
};
