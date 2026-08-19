const response = require("../utils/response");

const voiceService = require("../services/voiceService");

class VoiceController {

    async status(req, res, next) {

        try {
            return response.success(res, "Voice status", await voiceService.status());
        }
        catch (error) {
            next(error);
        }

    }

    config(req, res, next) {

        try {
            return response.success(res, "Voice config", voiceService.configView());
        }
        catch (error) {
            next(error);
        }

    }

    /** Daftar suara dari container TTS neural (bukan suara OS). */
    async voices(req, res, next) {

        try {
            return response.success(res, "Voices", await voiceService.voices());
        }
        catch (error) {
            next(error);
        }

    }

    saveConfig(req, res, next) {

        try {
            return response.success(res, "Konfigurasi suara disimpan",
                voiceService.setConfig(req.body ?? {}));
        }
        catch (error) {
            return response.error(res, error.message, 400);
        }

    }

    /** Hasilkan audio ucapan (dipakai renderer untuk suara neural). */
    async speak(req, res, next) {

        try {

            const { text, voice, format } = req.body ?? {};

            if (!text || !String(text).trim()) {
                return response.error(res, "Field 'text' wajib diisi.", 400);
            }

            const { audio, contentType } = await voiceService.speak(text, { voice, format });

            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", audio.length);

            return res.end(audio);

        }

        catch (error) {

            if (error.code === "TTS_NOT_CONFIGURED") {
                return response.error(res, error.message, 400);
            }

            return response.error(res, error.message, 502);

        }

    }

    /**
     * Terima audio (base64) dari renderer, kembalikan teks.
     *
     * Base64 dipilih ketimbang multipart karena renderer sudah
     * memegang Blob rekaman dan JSON lebih mudah lewat lapisan
     * fetch yang sama dengan endpoint lain.
     */
    async transcribe(req, res, next) {

        try {

            const { audio, mimeType, language } = req.body ?? {};

            if (!audio) {
                return response.error(res, "Field 'audio' (base64) wajib diisi.", 400);
            }

            const buffer = Buffer.from(audio, "base64");

            const result = await voiceService.transcribe(buffer, {
                mimeType: mimeType ?? "audio/webm",
                language: language ?? "id"
            });

            return response.success(res, "Transkripsi selesai", result);

        }

        catch (error) {

            // Belum dikonfigurasi bukan error server — beri 400 dengan
            // pesan yang bisa ditindaklanjuti Console.
            if (error.code === "STT_NOT_CONFIGURED") {
                return response.error(res, error.message, 400);
            }

            return response.error(res, error.message, 502);

        }

    }

}

module.exports = new VoiceController();
