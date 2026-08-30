const express = require("express");
const { rejectLegacyActionMiddleware } = require("../../../manager/legacyBoundary");

const aiController = require("../../../controllers/aiController");
const integrationController = require("../../../controllers/integrationController");
const deviceController = require("../../../controllers/deviceController");
const telemetryController = require("../../../controllers/telemetryController");
const pluginController = require("../../../controllers/pluginController");
const memoryController = require("../../../controllers/memoryController");
const voiceController = require("../../../controllers/voiceController");
const forgeController = require("../../../controllers/forgeController");
const whatsappController = require("../../../controllers/whatsappController");
const telegramController = require("../../../controllers/telegramController");
const channelController = require("../../../controllers/channelController");
const companionController = require("../../../companion/deviceController");
const mcpController = require("../../../controllers/mcpController");
const pulse = require("../../../autonomy/pulse");
const watchdog = require("../../../autonomy/watchdog");
const dream = require("../../../autonomy/dream");
const orchestratorController = require("../../../controllers/orchestratorController");
const homeController = require("../../../controllers/homeController");
const visionController = require("../../../controllers/visionController");
const peopleController = require("../../../controllers/peopleController");
const contextController = require("../../../controllers/contextController");
const automationController = require("../../../controllers/automationController");
const roleController = require("../../../controllers/roleController");
const terminalController = require("../../../controllers/terminalController");
const runtimeController = require("../../../controllers/runtimeController");
const safetyController = require("../../../controllers/safetyController");
const nasController = require("../../../controllers/nasController");
const filesController = require("../../../controllers/filesController");
const personalController = require("../../../controllers/personalController");
const osintController = require("../../../controllers/osintController");

const router = express.Router();
const managerOnly = rejectLegacyActionMiddleware("Console action");
const homeManagerOnly = rejectLegacyActionMiddleware("home/device action");
const labManagerOnly = rejectLegacyActionMiddleware("Lab action");
const automationManagerOnly = rejectLegacyActionMiddleware("automation action");
const mcpManagerOnly = rejectLegacyActionMiddleware("MCP administration action");

// ---- Dashboard & telemetri ------------------------------------

// Keselamatan (§37). Diletakkan paling atas karena harus tetap
// terjangkau walau bagian lain sedang bermasalah.
router.get("/safety", safetyController.status);
router.post("/safety/stop", safetyController.stop);
router.post("/safety/release", safetyController.release);
router.get("/safety/trail", safetyController.trail);
router.get("/safety/risk/:id", safetyController.riskOfTool);

router.get("/overview", telemetryController.overview);
router.get("/context", contextController.snapshot);
router.post("/context/brief", contextController.brief);
router.get("/stats", telemetryController.stats);
router.get("/logs", telemetryController.logs);
router.get("/events", telemetryController.events);

// ---- AI runtime ------------------------------------------------

router.get("/ai/config", aiController.config);
router.post("/ai/config", managerOnly);
router.get("/ai/providers", aiController.providers);
router.post("/ai/provider", managerOnly);
router.get("/ai/models", aiController.models);
router.post("/ai/models/verify", aiController.verifyModels);
router.post("/ai/model", managerOnly);
router.get("/ai/metrics", aiController.metrics);
router.post("/ai/chat", aiController.chat);
router.post("/ai/stream", aiController.stream);

// ---- Plugin & tool ---------------------------------------------

router.get("/plugins", pluginController.list);
router.get("/tools", pluginController.tools);
router.post("/tools/:id/execute", pluginController.execute);

// ---- Forge (Damar bikin tool sendiri / editor manual) ---------

router.get("/forge", forgeController.list);
router.post("/forge", managerOnly);
router.get("/forge/:id", forgeController.read);
router.post("/forge/:id/approve", managerOnly);
router.post("/forge/:id/reject", managerOnly);
router.delete("/forge/:id", managerOnly);

// ---- Home automation -------------------------------------------

router.get("/home/status", homeController.status);
router.get("/home/config", homeController.config);
router.post("/home/config", homeManagerOnly);
router.get("/home/devices", homeController.devices);
router.post("/home/control", homeManagerOnly);
// CCTV Home Assistant: daftarnya, dan gambarnya diteruskan daemon
// supaya token HA tidak ikut ke renderer.
router.get("/home/cameras", homeController.cameras);
router.get("/home/camera/:id/snapshot", homeController.cameraSnapshot);

// MQTT: broker, discovery perangkat, kendali langsung command topic.
router.get("/home/mqtt/status", homeController.mqttStatus);
router.post("/home/mqtt/config", homeManagerOnly);
router.post("/home/mqtt/connect", homeManagerOnly);
router.post("/home/mqtt/disconnect", homeManagerOnly);
router.post("/home/mqtt/publish", homeManagerOnly);

// ---- Vision ----------------------------------------------------

router.get("/vision/status", visionController.status);
router.get("/vision/config", visionController.config);
router.get("/vision/raw", visionController.rawFile);
// Proksi gambar Immich (daemon menambahkan x-api-key; <img> tak bisa).
router.get("/vision/immich", visionController.immichProxy);
router.post("/vision/config", managerOnly);
router.post("/vision/analyze", visionController.analyze);
router.get("/cameras", visionController.cameras);
router.post("/cameras", homeManagerOnly);
router.delete("/cameras/:id", homeManagerOnly);
router.get("/cameras/:id/snapshot", visionController.snapshot);
router.post("/cameras/:id/see", homeManagerOnly);

// ---- Orang & wajah (Immich + face-match) -----------------------

router.get("/people/status", peopleController.status);
router.post("/people/immich", managerOnly);
router.post("/people/face", managerOnly);
router.get("/people", peopleController.people);
router.post("/people/search", peopleController.search);

// ---- Multi-agent orkestrasi ------------------------------------

router.get("/agents", orchestratorController.agents);
router.post("/orchestrate", managerOnly);

// ---- Damar Lab (laboratorium kolaboratif) ---------------------------
const labController = require("../../../controllers/labController");
router.get("/lab/projects", labController.projectsList);
router.post("/lab/projects", labManagerOnly);
router.get("/lab/projects/:id", labController.projectGet);
router.post("/lab/projects/:id/activate", labManagerOnly); // kompat v1
router.patch("/lab/projects/:id", labManagerOnly);
router.delete("/lab/projects/:id", labManagerOnly);
router.get("/lab/projects/:id/browse", labController.projectBrowse);
router.post("/lab/projects/:id/vscode", labManagerOnly);
router.get("/lab/projects/:id/timeline", labController.projectTimeline);
router.post("/lab/projects/:id/phase", labManagerOnly);
router.post("/lab/projects/:id/memory", labManagerOnly);
router.get("/lab/projects/:id/memory", labController.memoryRecall);
router.get("/lab/projects/:id/memory/summary", labController.memorySummary);
router.post("/lab/projects/:id/knowledge", labManagerOnly);
router.post("/lab/projects/:id/snapshots", labManagerOnly);
router.get("/lab/projects/:id/snapshots", labController.snapshotsList);
router.get("/lab/missions", labController.missionsList);
router.post("/lab/missions", labManagerOnly);
router.get("/lab/missions/:id", labController.missionGet);
router.post("/lab/missions/:id/run", labManagerOnly);
// Terapkan hasil misi ke Damar utama (memori / Beranda / misi lanjutan / kode).
router.post("/lab/missions/:id/apply", labManagerOnly);
router.post("/lab/missions/:id/status", labManagerOnly);
router.post("/lab/missions/:id/resume", labManagerOnly);
router.get("/lab/activity", labController.activityList);
router.get("/lab/agents", labController.agentsBoard);
router.get("/lab/instruments", labController.instrumentsList);

// Graf koding dari graphify (visualisasi struktur repo).
const graphController = require("../../../controllers/graphController");
router.get("/graph/coding", graphController.coding);
router.get("/lab/artifacts", labController.artifactsList);
router.post("/lab/artifacts", labManagerOnly);
router.get("/lab/decisions", labController.decisionsList);
router.post("/lab/decisions", labManagerOnly);
router.get("/lab/experiments", labController.experimentsList);
router.post("/lab/experiments", labManagerOnly);
router.post("/lab/experiments/:id/run", labManagerOnly);
router.post("/lab/tests", labManagerOnly);

// ---- WhatsApp --------------------------------------------------

// ---- Runtime API (status runtime inti utk Runtime Console) -----

router.get("/runtime/status", runtimeController.status);
router.post("/runtime/:key/restart", runtimeController.restart);

// ---- Terminal Runtime (sesi pty persisten) ---------------------

router.get("/terminals", terminalController.list);
router.post("/terminals", terminalController.create);
router.get("/terminals/:id/output", terminalController.read);
router.post("/terminals/:id/input", terminalController.input);
router.post("/terminals/:id/signal", terminalController.signal);
router.post("/terminals/:id/resize", terminalController.resize);
router.post("/terminals/:id/execute", terminalController.execute);
router.patch("/terminals/:id", terminalController.rename);
router.delete("/terminals/:id", terminalController.remove);

// ---- Peran pengguna (SuperAdmin/Admin/User) --------------------

router.get("/roles", roleController.status);
router.post("/roles", managerOnly);

// ---- Proaktif (brief terjadwal) --------------------------------

router.get("/automation/status", automationController.status);
router.post("/automation/config", automationManagerOnly);
router.post("/automation/run", automationManagerOnly);

// ---- WhatsApp --------------------------------------------------

router.get("/whatsapp/status", whatsappController.status);
router.get("/whatsapp/groups", whatsappController.groups);
router.post("/whatsapp/config", managerOnly);
router.post("/whatsapp/connect", managerOnly);
router.post("/whatsapp/logout", managerOnly);
router.post("/whatsapp/test", managerOnly);

router.get("/telegram/status", telegramController.status);
router.post("/telegram/config", managerOnly);
router.post("/telegram/test", managerOnly);
router.post("/telegram/reconnect", managerOnly);

// ---- Kanal & sesi percakapan persisten --------------------------

router.get("/channels", channelController.list);
router.get("/channels/sessions", channelController.sessions);
router.delete("/channels/sessions/:key", managerOnly);

// ---- MCP: kelola server eksternal + status ekspos ----------------

router.get("/mcp/servers", mcpController.list);
router.post("/mcp/servers", mcpManagerOnly);
router.delete("/mcp/servers/:id", mcpManagerOnly);
router.post("/mcp/restart", mcpManagerOnly);

// ---- Otonomi: pulse · watchdog · dream ---------------------------

router.get("/pulse/latest", (req,res) => {
    res.json({ success:true, message:"Pulse", data: pulse.latest() });
});
router.get("/watchdog/status", (req,res) => {
    res.json({ success:true, message:"Watchdog", data: watchdog.status() });
});
router.get("/dream/status", (req,res) => {
    res.json({ success:true, message:"Dream", data: dream.status() });
});

// ---- Device tertaut (companion) — manajemen oleh owner ----------

router.post("/companion/pair", managerOnly);
router.get("/companion/list", companionController.list);
router.get("/companion/qr", companionController.qr);
router.post("/companion/:id/revoke", managerOnly);

// ---- Integrasi eksternal ---------------------------------------

router.get("/integrations", integrationController.list);
router.post("/integrations/check", managerOnly);
router.post("/integrations/:id/check", managerOnly);
router.patch("/integrations/:id", managerOnly);
router.get("/integrations/:id/models", integrationController.models);

// ---- Memori jangka panjang -------------------------------------

router.get("/memory/stats", memoryController.stats);
router.get("/memory", memoryController.list);
router.post("/memory", managerOnly);
router.post("/memory/recall", memoryController.recall);
router.post("/memory/consolidate", managerOnly);
router.get("/memory/embeddings", memoryController.embeddingStatus);
router.post("/memory/embeddings/backfill", managerOnly);

router.get("/memory/entities", memoryController.entities);
router.post("/memory/entities", managerOnly);
router.get("/memory/entities/:id", memoryController.entity);
router.patch("/memory/entities/:id", managerOnly);
router.delete("/memory/entities/:id", managerOnly);

router.get("/memory/documents", memoryController.documents);
router.post("/memory/documents", managerOnly);
router.post("/memory/upload", managerOnly);
router.get("/memory/documents/:id/chunks", memoryController.documentChunks);
router.delete("/memory/documents/:id", managerOnly);

// Governance: proposal memori ask-tier + audit. Sebelum "/memory/:id".
router.get("/memory/proposals", memoryController.proposals);
router.post("/memory/proposals/:id/approve", managerOnly);
router.post("/memory/proposals/:id/reject", managerOnly);
router.get("/memory/audit", memoryController.audit);

// Rute ber-parameter ditaruh paling akhir agar tidak menelan
// "/memory/entities" dan kawan-kawan.
router.get("/memory/:id", memoryController.get);
router.patch("/memory/:id", managerOnly);
router.delete("/memory/:id", managerOnly);

// ---- Suara (STT) -----------------------------------------------

router.get("/voice/status", voiceController.status);
router.get("/voice/config", voiceController.config);
router.get("/voice/voices", voiceController.voices);
router.post("/voice/config", managerOnly);
router.post("/voice/transcribe", voiceController.transcribe);
router.post("/voice/speak", managerOnly);

// Crypto (Binance): config + uji koneksi untuk panel Settings.
const cryptoController = require("../../../controllers/cryptoController");
router.get("/crypto/config", cryptoController.config);
router.post("/crypto/config", managerOnly);
router.get("/crypto/status", cryptoController.status);

// Sajikan media terunduh (mp4) untuk <video> Console. Auth via header
// atau ?token= (lihat middleware auth) sebab elemen <video> tak bisa
// mengirim header Authorization.
const mediaController = require("../../../controllers/mediaController");
router.get("/media/:id", mediaController.serve);

// ---- Perangkat (mic / kamera / sensor) -------------------------

router.get("/devices", deviceController.get);
router.put("/devices", managerOnly);
router.post("/devices/sensors", managerOnly);
router.delete("/devices/sensors/:id", managerOnly);
router.get("/devices/sensors/readings", deviceController.readSensors);

// ---- Kebocoran Data (gratis, tanpa key) ---------------------------

router.post("/osint/breach", osintController.breachCheck);
router.post("/osint/breach/summary", osintController.breachSummary);

// ---- Telepon Intelijen (mitigasi penipuan) ------------------------

router.post("/osint/phone/analyze", osintController.phoneAnalyze);
router.post("/osint/phone/assess", osintController.phoneAssess);
router.post("/osint/phone/blacklist/add", managerOnly);
router.post("/osint/phone/blacklist/remove", managerOnly);
router.post("/osint/phone/whitelist/add", managerOnly);
router.get("/osint/phone/list", osintController.phoneList);

// ---- Pelacakan Orang (opt-in) --------------------------------------

router.get("/osint/track/list", osintController.personList);
router.post("/osint/track/register", managerOnly);
router.post("/osint/track/update", managerOnly);
router.get("/osint/track/:id", osintController.personDetail);
router.post("/osint/track/:id/revoke", managerOnly);
router.post("/osint/track/geofence", managerOnly);
router.get("/osint/track/geofence/list", osintController.personGeofenceList);
router.get("/osint/track/geofence/:id/check", osintController.personGeofenceCheck);
router.get("/osint/track/nearby", osintController.personNearby);

// ---- OSINT (investigasi & detektif digital) ---------------------

router.post("/osint/investigate", osintController.investigate);
router.post("/osint/email", osintController.email);
router.post("/osint/username", osintController.username);
router.post("/osint/domain", osintController.domain);
router.get("/osint/platforms", osintController.platforms);

router.post("/osint/cases", managerOnly);
router.get("/osint/cases", osintController.caseList);
router.get("/osint/cases/:id", osintController.caseDetail);
router.post("/osint/cases/:id/findings", managerOnly);
router.post("/osint/cases/:id/evidence", managerOnly);
router.post("/osint/cases/:id/close", managerOnly);
router.delete("/osint/cases/:id", managerOnly);
router.get("/osint/cases/:id/export", osintController.caseExport);

// ---- Social Intelligence -------------------------------------------

router.post("/osint/social/bot", managerOnly);
router.post("/osint/social/comments", managerOnly);
router.post("/osint/social/location", managerOnly);
router.post("/osint/social/network", managerOnly);
router.post("/osint/hoax/check", osintController.hoaxCheck);
router.post("/osint/hoax/trace", osintController.hoaxTrace);

// ---- NAS (penyimpanan & host, data nyata) ----------------------

router.get("/nas/status", nasController.status);
router.get("/nas/config", nasController.config);
router.post("/nas/config", managerOnly);
router.get("/nas/immich", nasController.immichStatus);
router.post("/nas/immich/up", managerOnly);
router.post("/nas/immich/down", managerOnly);
router.get("/nas/pools", nasController.pools);
router.get("/nas/backup", nasController.backups);
router.post("/nas/backup", managerOnly);
router.post("/nas/backup/:id/run", managerOnly);
router.delete("/nas/backup/:id", managerOnly);
router.post("/nas/notify/test", managerOnly);
router.post("/nas/monitor/check", managerOnly);

// ---- Files (penjelajah berkas lokal, read-only) ----------------

router.get("/files", filesController.list);

// ---- Cuaca & profil (dashboard) --------------------------------

router.get("/ai/usage", aiController.usage);

router.get("/weather", personalController.weather);
router.post("/weather/config", managerOnly);
router.get("/profile", personalController.profile);
router.post("/profile", managerOnly);

module.exports = router;
