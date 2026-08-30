const express = require("express");

const deviceController = require("../../../companion/deviceController");
const aiConsoleController = require("../../../controllers/aiController");
const { deviceAuth } = require("../../../companion");
const { rejectLegacyActionMiddleware } = require("../../../manager/legacyBoundary");

const router = express.Router();

/**
 * Endpoint Companion untuk DEVICE (bukan owner).
 *
 *   - GET  /companion (halaman web)          → routes/index.js
 *   - POST /api/v1/companion/join            → join dengan kode pairing
 *   - POST /api/v1/companion/chat/stream     → chat SSE streaming
 *   - POST /api/v1/companion/transcribe|tts  → suara
 *   - POST /api/v1/companion/upload          · GET media/:file → lampiran
 *   - GET  /ai/providers|models|config       → baca konfigurasi otak AI
 *   - POST /ai/select                        → ganti provider/model aktif
 *   - POST /ai/config                        → DELEGASI penuh ke
 *     aiController Console (provider + apiKey + baseUrl + model; key
 *     dimasking saat dibaca, diverifikasi saat disimpan)
 *
 * Endpoint MANAJEMEN ada di /api/v1/console/companion/* (token owner).
 */

router.post("/join", rejectLegacyActionMiddleware("Companion pairing"));
router.post("/chat", deviceAuth, deviceController.chat);
router.post("/chat/stream", deviceAuth, deviceController.chatStream);
router.post("/transcribe", deviceAuth, deviceController.transcribe);
router.post("/tts", deviceAuth, rejectLegacyActionMiddleware("Companion voice action"));
router.post("/upload", deviceAuth, rejectLegacyActionMiddleware("Companion upload action"));
router.get("/media/:file", deviceAuth, deviceController.media);
router.get("/tools", deviceAuth, deviceController.tools);
router.get("/mood", deviceAuth, deviceController.mood);
router.post("/panic", deviceAuth, rejectLegacyActionMiddleware("Companion action"));

// Kendali AI dari device — setara Console.
router.get("/ai/providers", deviceAuth, deviceController.aiProviders);
router.get("/ai/models", deviceAuth, deviceController.aiModels);
router.post("/ai/select", deviceAuth, rejectLegacyActionMiddleware("Companion AI configuration"));
router.get("/ai/config", deviceAuth, aiConsoleController.config);
router.post("/ai/config", deviceAuth, rejectLegacyActionMiddleware("Companion AI configuration"));

module.exports = router;
