"use strict";

/**
 * server — Voice Local Server Damar.
 *
 * Satu proses lokal (127.0.0.1) yang menyajikan dialek OpenAI yang SUDAH
 * dipakai voiceService, diisi mesin yang benar-benar lokal & offline:
 *
 *   POST /v1/audio/transcriptions  → whisper.cpp (ggml, CPU)
 *   POST /v1/audio/speech          → Supertonic 3 id_ID pria (ONNX, CPU;
 *     default) atau Piper id_ID (alternatif wanita, ONNX, CPU)
 *   GET  /v1/models                → daftar model lokal (probe voiceService)
 *   GET  /v1/audio/voices          — daftar suara lokal (Supertonic + Piper)
 *   POST /v1/audio/envelope        → envelope amplitudo WAV (kontrak lip-sync)
 *   GET  /health                   → kesiapan mesin
 *
 * Respons TTS membawa header X-Damar-Envelope (base64 JSON {frameMs,frames})
 * — envelope amplitudo 0..1 dari audio yang baru disintesis, bentuk yang
 * sama dengan `voiceAmp` yang dikonsumsi Presence renderer.
 *
 * Konfigurasi: configs/voice.json (satu sumber terpusat) lewat
 * src/voice/config.js + env DAMAR_VOICE_LOCAL_*. Tanpa dependency npm.
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const engines = require("./engines");
const { computeEnvelope } = require("../providers/speechEnvelope");

const pexec = promisify(execFile);

const DEFAULT_PORT = 8127;

/** Antrian serial sederhana: STT/TTS berat CPU — jangan ditumpuk. */
function serialQueue() {
    let tail = Promise.resolve();
    return fn => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => {});
        return run;
    };
}

/** Parser multipart/form-data minimal & binary-safe (cukup untuk FormData). */
function parseMultipart(buffer, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
    if (!m) return null;
    const boundary = Buffer.from(`--${m[1] || m[2]}`);
    const fields = {};
    let pos = 0;
    while (true) {
        const start = buffer.indexOf(boundary, pos);
        if (start < 0) break;
        let p = start + boundary.length;
        if (buffer[p] === 0x2d) break; // -- penutup
        if (buffer[p] === 0x0d) p += 2; else if (buffer[p] === 0x0a) p += 1;
        const headEnd = buffer.indexOf("\r\n\r\n", p);
        if (headEnd < 0) break;
        const head = buffer.toString("latin1", p, headEnd);
        const bodyStart = headEnd + 4;
        const next = buffer.indexOf(boundary, bodyStart);
        if (next < 0) break;
        let bodyEnd = next;
        if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
        const body = buffer.subarray(bodyStart, bodyEnd);
        const nameM = /name="([^"]+)"/.exec(head);
        if (nameM) {
            const filenameM = /filename="([^"]*)"/.exec(head);
            fields[nameM[1]] = filenameM ? { filename: filenameM[1], data: Buffer.from(body) } : body.toString("utf8");
        }
        pos = next;
    }
    return fields;
}

function readBody(req, limit = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", c => {
            size += c.length;
            if (size > limit) { reject(new Error("body terlalu besar")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}

/** WAV → MP3 lewat ffmpeg lokal (untuk response_format=mp3). */
async function wavToMp3(wavBuffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-voice-mp3-"));
    try {
        const inF = path.join(dir, "in.wav");
        const outF = path.join(dir, "out.mp3");
        fs.writeFileSync(inF, wavBuffer);
        await pexec("ffmpeg", ["-y", "-v", "error", "-i", inF, "-codec:a", "libmp3lame", "-q:a", "4", outF],
            { timeout: 60000, windowsHide: true });
        return fs.readFileSync(outF);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ }
    }
}

/**
 * Buat server. `engineImpl` bisa ditimpa untuk tes hermetik.
 * @param {object} [opts] { port, host, engineImpl, defaultSttModel, defaultTtsVoice, log }
 */
function createVoiceLocalServer(opts = {}) {
    const eng = opts.engineImpl || engines;
    const sttQueue = serialQueue();
    const ttsQueue = serialQueue();
    const log = opts.log || (() => {});
    const defaultSttModel = opts.defaultSttModel || "ggml-small";
    const defaultTtsVoice = opts.defaultTtsVoice || "supertonic-M1";
    // Model resident (hangat): satu WarmWhisperServer per model yang diminta.
    // opts.warm: false = matikan; selain itu daftar {model, port}.
    // HANYA tiny yang dihangatkan: terukur di Aether (whisper-server v1.7.6),
    // inferensi server untuk model >= small MELAMBAT setelah permintaan
    // pertama (small: 2,3 dtk -> 5,9-6,4 dtk/panggilan) sehingga final
    // perintah justru lebih cepat lewat whisper-cli (2,65 dtk tetap, didominasi
    // muat model). Tiny resident melayani transkripsi parsial streaming.
    const warmSpecs = opts.warm === false ? [] : (opts.warm || [
        { model: "ggml-tiny", port: 8182 }
    ]);
    const warmByModel = new Map();

    async function transcribeRouted(audio, { model, language }) {
        // Jalur hangat hanya untuk tiny (lihat catatan warmSpecs di atas).
        const warm = String(model).toLowerCase() === "ggml-tiny"
            ? warmByModel.get("ggml-tiny") : null;
        if (warm && warm.ok) return warm.transcribe(audio, { language });
        return eng.transcribeWav(audio, { model, language });
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        try {
            if (req.method === "GET" && url.pathname === "/health") {
                return json(res, 200, {
                    ok: true, engines: eng.probe(),
                    defaults: { sttModel: defaultSttModel, ttsVoice: defaultTtsVoice },
                    warm: [...warmByModel.values()].map(w => w.status())
                });
            }

            if (req.method === "GET" && url.pathname === "/v1/models") {
                const data = eng.listWhisperModels().map(m => ({ id: m.id, object: "model", owned_by: "damar-local" }));
                data.push({ id: "piper-id", object: "model", owned_by: "damar-local" });
                // Supertonic terpasang -> cantumkan modelnya (guarded: fake
                // engineImpl di tes tidak punya listSupertonicVoices).
                if (typeof eng.listSupertonicVoices === "function") {
                    try { if (eng.listSupertonicVoices().length > 0) data.push({ id: "supertonic-3", object: "model", owned_by: "damar-local" }); } catch { /* abaikan */ }
                }
                return json(res, 200, { object: "list", data });
            }

            if (req.method === "GET" && url.pathname === "/v1/audio/voices") {
                const voices = eng.listPiperVoices().map(v => ({ id: v.id, name: `${v.id} (Piper, lokal)` }));
                // Supertonic dulu (default ada di urutan ini); guarded agar
                // fake engineImpl lama tetap jalan.
                if (typeof eng.listSupertonicVoices === "function") {
                    try {
                        const st = eng.listSupertonicVoices().map(v => ({ id: v.id, name: v.name || `${v.id} (Supertonic 3, lokal)` }));
                        voices.unshift(...st);
                    } catch { /* abaikan */ }
                }
                return json(res, 200, { voices });
            }

            if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
                const body = await readBody(req);
                let audio = null, model = defaultSttModel, language = "id";
                const ct = req.headers["content-type"] || "";
                if (ct.includes("multipart/form-data")) {
                    const fields = parseMultipart(body, ct);
                    if (!fields || !fields.file) return json(res, 400, { error: "field 'file' wajib ada" });
                    audio = fields.file.data;
                    if (fields.model) model = String(fields.model);
                    if (fields.language) language = String(fields.language);
                } else {
                    audio = body;
                    if (url.searchParams.get("model")) model = url.searchParams.get("model");
                    if (url.searchParams.get("language")) language = url.searchParams.get("language");
                }
                if (!audio || audio.length === 0) return json(res, 400, { error: "audio kosong" });
                const out = await sttQueue(() => transcribeRouted(audio, { model, language }));
                log(`[stt] model=${model} ms=${out.ms} chars=${out.text.length}`);
                return json(res, 200, { text: out.text });
            }

            if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
                const body = await readBody(req);
                let payload = {};
                try { payload = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "JSON tidak valid" }); }
                const text = String(payload.input ?? payload.text ?? "").trim();
                if (!text) return json(res, 400, { error: "field 'input' wajib diisi" });
                const voice = String(payload.voice || defaultTtsVoice);
                const format = String(payload.response_format || "wav").toLowerCase();
                const out = await ttsQueue(() => eng.synthesize(text, { voice }));
                let envelope = null;
                try { envelope = computeEnvelope(out.audio, { frameMs: 50 }); } catch { /* audio tetap dikirim */ }
                let audio = out.audio, contentType = "audio/wav";
                if (format === "mp3") {
                    audio = await wavToMp3(out.audio);
                    contentType = "audio/mpeg";
                }
                const headers = { "Content-Type": contentType, "Content-Length": audio.length, "X-Damar-Voice": out.voice, "X-Damar-Synth-Ms": String(out.ms) };
                if (envelope) {
                    headers["X-Damar-Envelope"] = Buffer.from(JSON.stringify({ frameMs: envelope.frameMs, frames: envelope.frames })).toString("base64");
                    headers["X-Damar-Duration-Ms"] = String(Math.round(envelope.durationMs));
                }
                res.writeHead(200, headers);
                return res.end(audio);
            }

            if (req.method === "POST" && url.pathname === "/v1/audio/speech/stream") {
                // TTS streaming per kalimat: NDJSON, satu baris per chunk —
                // chunk pertama keluar begitu kalimat pertama tersintesis,
                // tanpa menunggu seluruh teks. Konsumen memutar berurutan.
                const body = await readBody(req);
                let payload = {};
                try { payload = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "JSON tidak valid" }); }
                const text = String(payload.input ?? payload.text ?? "").trim();
                if (!text) return json(res, 400, { error: "field 'input' wajib diisi" });
                const voice = String(payload.voice || defaultTtsVoice);
                const { SentenceChunker } = require("./streaming");
                const chunker = new SentenceChunker();
                const parts = chunker.push(text);
                const tail = chunker.flush();
                if (tail) parts.push(tail);
                res.writeHead(200, { "Content-Type": "application/x-ndjson" });
                let index = 0;
                for (const part of parts) {
                    const out = await ttsQueue(() => eng.synthesize(part, { voice }));
                    let envelope = null;
                    try { envelope = computeEnvelope(out.audio, { frameMs: 50 }); } catch { /* abaikan */ }
                    res.write(JSON.stringify({
                        index: index++, text: part, voice: out.voice, synthMs: out.ms,
                        durationMs: envelope ? Math.round(envelope.durationMs) : null,
                        envelope: envelope ? { frameMs: envelope.frameMs, frames: envelope.frames } : null,
                        audio: out.audio.toString("base64")
                    }) + "\n");
                }
                return res.end();
            }

            if (req.method === "POST" && url.pathname === "/v1/audio/envelope") {
                const body = await readBody(req);
                let payload = {};
                try { payload = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "JSON tidak valid" }); }
                if (!payload.audio) return json(res, 400, { error: "field 'audio' (base64) wajib ada" });
                const env = computeEnvelope(Buffer.from(payload.audio, "base64"), { frameMs: payload.frameMs || 50 });
                return json(res, 200, env);
            }

            return json(res, 404, { error: "rute tidak dikenal" });
        } catch (error) {
            log(`[error] ${req.method} ${url.pathname}: ${error.message}`);
            return json(res, 500, { error: error.message });
        }
    });

    return {
        server,
        warmByModel,
        async startWarm() {
            for (const spec of warmSpecs) {
                if (!eng.WarmWhisperServer) break;
                try {
                    const warm = new eng.WarmWhisperServer({ model: spec.model, port: spec.port });
                    await warm.start();
                    warmByModel.set(String(spec.model).toLowerCase(), warm);
                    log(`[warm] ${spec.model} resident di :${spec.port} (muat ${warm.loadMs} ms)`);
                } catch (error) {
                    log(`[warm] ${spec.model} gagal resident: ${error.message} — jalur CLI dingin dipakai`);
                }
            }
        },
        listen(port = DEFAULT_PORT, host = "127.0.0.1") {
            return new Promise(resolve => server.listen(port, host, () => resolve(server.address())));
        },
        close() {
            for (const w of warmByModel.values()) w.stop();
            // Service Supertonic resident ikut mati (guarded: fake engineImpl
            // di tes tidak punya stopSupertonicServers).
            if (typeof eng.stopSupertonicServers === "function") { try { eng.stopSupertonicServers(); } catch { /* abaikan */ } }
            return new Promise(resolve => server.close(() => resolve()));
        }
    };
}

module.exports = { createVoiceLocalServer, parseMultipart, DEFAULT_PORT };

if (require.main === module) {
    let port = DEFAULT_PORT;
    try {
        const { voiceConfig } = require("../config");
        port = voiceConfig().localPort || DEFAULT_PORT;
    } catch { /* pakai default */ }
    const app = createVoiceLocalServer({ log: (...a) => console.log(...a) });
    app.listen(port).then(async addr => {
        await app.startWarm();
        console.log(`[voice-local] mendengarkan di http://${addr.address}:${addr.port}`);
        const p = engines.probe();
        console.log(`[voice-local] whisper: ${p.whisper.ok ? p.whisper.bin : "TIDAK ADA"} | model: ${p.whisper.models.map(m => m.id).join(", ") || "-"}`);
        console.log(`[voice-local] piper:   ${p.piper.ok ? p.piper.bin : "TIDAK ADA"} | suara: ${p.piper.voices.map(v => v.id).join(", ") || "-"}`);
    });
}
