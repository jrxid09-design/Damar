const express = require("express");
const response = require("../utils/response");

const router = express.Router();

/**
 * Jembatan OpenAI-compatible di atas otak Aether.
 *
 *   POST /v1/chat/completions   → aiRuntime.chat() (otak penuh:
 *                                 system prompt, memori, keadaan batin,
 *                                 tool-calling loop)
 *
 * Dipakai penghuni koloni AetherGenesis (Viel, NODEK-01, Nyx) lewat
 * aether-entities/lib/mind.js sebagai JATUH-BALIK saat otak utama
 * mereka (GeminiWebApi :4981) mati — sehingga entitas tetap bisa
 * berpikir dengan model lokal Qwen in-process tanpa kontainer luar.
 *
 * Autentikasi: Bearer AETHER_TOKEN (bila diset) — sama seperti bidang
 * kendali Console. Tanpa token, terbuka (untuk pengembangan).
 *
 * Format mengikuti skema OpenAI Chat Completions secukupnya:
 * model diabaikan (otak aktif Aether yang dipakai), messages
 * dipetakan apa adanya, temperature/max_tokens diteruskan.
 */

/** Autentikasi ringan: token opsional via env. */
function auth(req, res, next) {
    const token = process.env.AETHER_TOKEN;
    if (!token) return next();
    if (req.method === "OPTIONS") return next();
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : req.query.token;
    if (provided !== token) {
        return response.error(res, "Unauthorized. Sertakan header 'Authorization: Bearer <AETHER_TOKEN>'.", 401);
    }
    next();
}

router.use(auth);

/** GET /v1/models — daftar model (satu: otak aktif Aether). */
router.get("/models", async (req, res, next) => {
    try {
        const aiRuntime = require("../services/aiRuntimeService");
        const platform = aiRuntime.activePlatform;
        res.json({
            object: "list",
            data: [{
                id: platform?.model || "aether-local",
                object: "model",
                owned_by: "aether"
            }]
        });
    }
    catch (error) { next(error); }
});

/** POST /v1/chat/completions — satu putaran chat (non-streaming). */
router.post("/chat/completions", async (req, res, next) => {
    try {
        const { messages, temperature, max_tokens } = req.body || {};

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: { message: "'messages' wajib array berisi.", type: "invalid_request_error", code: "400" }
            });
        }

        const aiRuntime = require("../services/aiRuntimeService");

        const result = await aiRuntime.chat({
            messages,
            temperature,
            maxTokens: max_tokens,
            // Tanpa channel: ini panggilan mesin-ke-mesin; kanal (console/
            // whatsapp/telegram) tidak berlaku, dan prompt kanal justru
            // akan membingungkan entitas koloni.
        });

        const model = aiRuntime.activePlatform?.model || "aether-local";

        res.json({
            id: "chatcmpl-" + Date.now().toString(36),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: "assistant", content: result.content ?? "" },
                finish_reason: "stop"
            }],
            usage: result.usage ?? {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        });
    }
    catch (error) {
        // Format error ala OpenAI supaya klien (mind.js) menangkapnya
        // sebagai kegagalan HTTP, bukan crash parsing.
        res.status(500).json({
            error: { message: error.message || "Aether gagal memproses.", type: "server_error", code: "500" }
        });
    }
});

module.exports = router;
