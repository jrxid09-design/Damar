const express = require("express");
const response = require("../utils/response");

const router = express.Router();

/**
 * Jembatan OpenAI-compatible di atas otak Damar.
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
 * Autentikasi: Bearer DAMAR_TOKEN (bila diset) — sama seperti bidang
 * kendali Console. Tanpa token, terbuka (untuk pengembangan).
 *
 * Format mengikuti skema OpenAI Chat Completions secukupnya:
 * model diabaikan (otak aktif Damar yang dipakai), messages
 * dipetakan apa adanya, temperature/max_tokens diteruskan.
 */

/**
 * Autentikasi — FAIL-CLOSED (temuan C4).
 *
 * Endpoint ini terekspos ke jaringan. Dulu: token kosong = terbuka
 * "untuk pengembangan" — persis pola fail-open yang dilarang.
 *
 * Kini:
 *   - tanpa DAMAR_TOKEN → 503 (endpoint tidak tersedia), BUKAN open;
 *   - DAMAR_UNSAFE_DEV_OPEN_API="1" satu-satunya pintu mode terbuka,
 *     dengan peringatan keras saat boot (opt-in eksplisit, default aman);
 *   - token valid → identitas eksekusi: role dari DAMAR_API_ROLE
 *     (default 'user' — API eksternal = hak minimum).
 */
function auth(req, res, next) {

    if (req.method === "OPTIONS") return next();

    const token = process.env.DAMAR_TOKEN;

    if (!token) {

        const devOpen = process.env.DAMAR_UNSAFE_DEV_OPEN_API === "1";

        if (!devOpen) {
            return response.error(res,
                "Layanan API terkunci: DAMAR_TOKEN belum diset. " +
                "Set token, atau setel DAMAR_UNSAFE_DEV_OPEN_API=1 untuk mode pengembangan yang berisiko.",
                503);
        }

        // Mode dev terbuka: identitas paling terbatas tetap dipakai.
        req.execIdentity = { role: "user", channel: "api", sessionId: `api:${req.ip ?? "dev"}` };
        return next();
    }

    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : req.query.token;

    if (provided !== token) {
        return response.error(res, "Unauthorized. Sertakan header 'Authorization: Bearer <DAMAR_TOKEN>'.", 401);
    }

    // Identitas eksekusi untuk seluruh handler di router ini.
    req.execIdentity = {
        role: process.env.DAMAR_API_ROLE ?? "user",
        channel: "api",
        sessionId: `api:${req.ip ?? "unknown"}`
    };

    next();
}

router.use(auth);

/** GET /v1/models — daftar model (satu: otak aktif Damar). */
router.get("/models", async (req, res, next) => {
    try {
        const aiRuntime = require("../services/aiRuntimeService");
        const platform = aiRuntime.activePlatform;
        res.json({
            object: "list",
            data: [{
                id: platform?.model || "damar-local",
                object: "model",
                owned_by: "damar"
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
            // Identitas dari gerbang auth — role API default 'user'.
            role: req.execIdentity?.role,
            sessionId: req.execIdentity?.sessionId,
            // Tanpa channel: ini panggilan mesin-ke-mesin; kanal (console/
            // whatsapp/telegram) tidak berlaku, dan prompt kanal justru
            // akan membingungkan entitas koloni.
        });

        const model = aiRuntime.activePlatform?.model || "damar-local";

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
            error: { message: error.message || "Damar gagal memproses.", type: "server_error", code: "500" }
        });
    }
});

module.exports = router;
