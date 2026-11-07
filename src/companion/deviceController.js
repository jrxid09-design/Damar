const response = require("../utils/response");

const telemetry = require("../services/telemetryService");

const { deviceRegistry, pairing, gateway } = require("./index");

/**
 * DeviceController — kendali device tertaut (companion) lewat REST.
 *
 * Alur (kode dimulai dari OWNER):
 *   1. Pemilik buat kode     → POST /console/companion/pair   → kode 6 digit
 *   2. Device join           → POST /companion/join {code,name} (TANPA token owner)
 *                            → device dibuat + token dikembalikan ke device
 *   3. Device memakai token  → chat / tools lewat /companion/* (Bearer token device)
 *   4. Pemilik cabut         → POST /console/companion/:id/revoke
 */

class DeviceController {

    /** [OWNER] Buat kode pairing baru (ditampilkan di Console). */
    request(req, res, next) {

        try {
            const result = pairing.request();
            return response.success(res, "Pairing code issued", result, 201);
        }
        catch (error) {
            if (error.code === "PAIRING_BUSY") {
                return response.error(res, error.message, 429);
            }
            next(error);
        }

    }

    /**
     * [DEVICE] Join dengan kode + nama. TANPA auth owner — keamanannya
     * adalah kode 6 digit yang dibuat pemilik (TTL 10 menit).
     */
    join(req, res, next) {

        try {

            const { code, name, kind } = req.body ?? {};

            if (!code) {
                return response.error(res, "Field 'code' wajib diisi.", 400);
            }

            const entry = pairing.join(code, { name, kind });

            if (!entry) {
                return response.error(res, "Kode pairing salah atau kedaluwarsa.", 400);
            }

            const device = deviceRegistry.create({ name: entry.name, kind: entry.kind });

            // Token dikembalikan SEKALI — langsung ke device yang join.
            return response.success(res, "Device tertaut", {
                id: device.id,
                name: device.name,
                kind: device.kind,
                token: device.token
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** Daftar device tertaut (pemilik) + alamat akses (LAN/Tailscale). */
    list(req, res, next) {

        try {

            const { detectAddresses, companionUrls } = require("./addresses");
            const config = require("../config/env");

            const access = detectAddresses({ port: config.port });

            return response.success(res, "Devices", {
                devices: deviceRegistry.publicList(),
                pending: pairing.count(),
                access,
                urls: companionUrls(access)
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** [OWNER] QR code untuk sebuah URL companion (?url=http://...). */
    async qr(req, res, next) {

        try {

            const url = String(req.query.url ?? "");

            if (!/^https?:\/\/.+/.test(url) || url.length > 500) {
                return response.error(res, "URL tidak sah.", 400);
            }

            let lib;
            try { lib = require("qrcode"); }
            catch {
                return response.error(res, "Paket qrcode belum terinstall.", 501);
            }

            const dataUrl = await lib.toDataURL(url, { margin: 1, width: 260 });

            return response.success(res, "QR", { url, dataUrl });

        }
        catch (error) {
            next(error);
        }

    }

    /** Cabut akses device. */
    revoke(req, res, next) {

        try {

            const ok = deviceRegistry.revoke(req.params.id);

            if (!ok) {
                return response.error(res, "Device tidak ditemukan.", 404);
            }

            return response.success(res, "Device dicabut", { id: req.params.id });

        }
        catch (error) {
            next(error);
        }

    }

    /** Chat dari device (auth = token device). */
    async chat(req, res, next) {

        try {

            const device = req.device; // disuntik middleware auth device

            const { text } = req.body ?? {};

            if (!text || !String(text).trim()) {
                return response.error(res, "Field 'text' wajib diisi.", 400);
            }

            const { answer } = await gateway.chat(device, text);

            return response.success(res, "Damar", { answer });

        }
        catch (error) {
            next(error);
        }

    }

    /** Daftar tool/skill yang tersedia untuk device. */
    tools(req, res, next) {

        try {
            return response.success(res, "Tools", { tools: gateway.tools() });
        }
        catch (error) {
            next(error);
        }

    }

    // ---- Device v3: kendali AI (provider/model) ----------------------

    /** Daftar provider AI aktif (untuk setelan di device). */
    async aiProviders(req, res, next) {

        try {
            const aiRuntime = require("../services/aiRuntimeService");
            const data = await aiRuntime.providers();
            return response.success(res, "Providers", {
                active: data.active ?? null,
                defaultModel: aiRuntime.defaultModel ?? null,
                providers: data.providers ?? []
            });
        }
        catch (error) {
            next(error);
        }

    }

    /** Daftar model untuk satu provider (?provider=openrouter). */
    async aiModels(req, res, next) {

        try {
            const aiRuntime = require("../services/aiRuntimeService");
            const provider = req.query.provider ?? undefined;
            const models = await aiRuntime.models(provider);
            return response.success(res, "Models", { models });
        }
        catch (error) {
            next(error);
        }

    }

    /** Ganti provider + model (dipakai juga saat kuota 429 di device). */
    select(req, res, next) {

        try {

            const aiRuntime = require("../services/aiRuntimeService");
            const { provider, model } = req.body ?? {};

            if (provider) aiRuntime.switchProvider(String(provider));

            if (model) aiRuntime.setDefaultModel(String(model));

            return response.success(res, "AI dikonfigurasi", {
                active: aiRuntime.activePlatform?.id ?? null,
                defaultModel: aiRuntime.defaultModel ?? null
            });

        }
        catch (error) {
            next(error);
        }

    }

    /** Suasana hati Damar → orb device ikut mewarnai. */
    mood(req, res, next) {

        try {
            const mind = require("../consciousness");
            const a = mind.affect.now();
            return response.success(res, "Mood", {
                valence: a.valence,
                arousal: a.arousal,
                label: a.label
            });
        }
        catch (error) {
            next(error);
        }

    }

    /**
     * PANIC — kill switch dari device (ide liar #5).
     * Semua tool berhenti sampai pemilik melepasnya lewat Console/Safety.
     */
    panic(req, res, next) {

        try {

            const killSwitch = require("../core/safety/killSwitch");

            const reason =
                (req.body && req.body.reason) || "panic button dari device";

            const result = killSwitch.engage({
                actor: "device:" + (req.device?.id ?? "?"),
                reason
            });

            telemetry.publish("safety:stop", {
                actor: "device",
                reason,
                alreadyEngaged: result.alreadyEngaged
            });

            telemetry.warn(`[safety] PANIC ditarik dari device ${req.device?.id}`);

            return response.success(res, "Kill switch AKTIF", result);

        }
        catch (error) {
            next(error);
        }

    }

    // ---- Device v2: streaming, suara, media --------------------------

    /** Chat STREAMING dari device — SSE, delta per token. */
    async chatStream(req, res) {

        const device = req.device;
        const text = String(req.body?.text ?? "").trim();

        if (!text) {
            return response.error(res, "Field 'text' wajib diisi.", 400);
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        });

        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        let closed = false;
        res.on("close", () => { closed = true; });

        try {

            send("start", { device: device.id });

            await gateway.chatStream(device, text, (delta) => {
                if (!closed) send("chunk", { delta });
            });

            if (!closed) send("done", { ok: true });

        }
        catch (error) {
            if (!closed) send("error", { message: error.message });
        }
        finally {
            res.end();
        }

    }

    /** STT untuk device: audio base64 → teks (voiceService). */
    async transcribe(req, res, next) {

        try {

            const voice = require("../services/voiceService");

            const { audio, mimeType, language } = req.body ?? {};

            if (!audio) {
                return response.error(res, "Field 'audio' (base64) wajib diisi.", 400);
            }

            const buffer = Buffer.from(audio, "base64");

            const result = await voice.transcribe(buffer, {
                mimeType: mimeType ?? "audio/webm",
                language: language ?? "id"
            });

            return response.success(res, "Transkripsi selesai", result);

        }
        catch (error) {
            if (error.code === "STT_NOT_CONFIGURED") {
                return response.error(res, error.message, 400);
            }
            next(error);
        }

    }

    /** TTS untuk device: teks → audio mp3 (suara Damar dari server). */
    async tts(req, res, next) {

        try {

            const voice = require("../services/voiceService");

            const { text } = req.body ?? {};

            if (!text || !String(text).trim()) {
                return response.error(res, "Field 'text' wajib diisi.", 400);
            }

            const { audio, contentType } = await voice.speak(String(text).slice(0, 2000));

            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", audio.length);
            return res.end(audio);

        }
        catch (error) {
            if (error.code === "TTS_NOT_CONFIGURED") {
                return response.error(res, error.message, 400);
            }
            next(error);
        }

    }

    /** Upload lampiran (foto/berkas) dari device. */
    upload(req, res, next) {

        try {

            const { name, data, mimeType } = req.body ?? {};

            if (!data) {
                return response.error(res, "Field 'data' (base64) wajib diisi.", 400);
            }

            const saved = gateway.saveUpload({ name, data, mimeType });

            telemetry.publish("companion:upload", {
                device: req.device?.id,
                name: saved.name,
                bytes: saved.bytes
            });

            return response.success(res, "Lampiran tersimpan", saved, 201);

        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    /** Sajikan berkas lampiran (auth via ?token= karena <img> tak bisa header). */
    media(req, res) {

        const found = gateway.readUpload(req.params.file);

        if (!found) {
            return res.status(404).end();
        }

        res.setHeader("Content-Type", require("./companionGateway").CompanionGateway.contentTypeOf(req.params.file));
        res.setHeader("Cache-Control", "private, max-age=3600");
        return res.end(found.buffer);

    }

}

module.exports = new DeviceController();
