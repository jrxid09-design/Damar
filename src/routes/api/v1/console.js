const express = require("express");

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
router.post("/ai/config", aiController.saveConfig);
router.get("/ai/providers", aiController.providers);
router.post("/ai/provider", aiController.selectProvider);
router.get("/ai/models", aiController.models);
router.post("/ai/models/verify", aiController.verifyModels);
router.post("/ai/model", aiController.selectModel);
router.get("/ai/metrics", aiController.metrics);
router.post("/ai/chat", aiController.chat);
router.post("/ai/stream", aiController.stream);

// ---- Plugin & tool ---------------------------------------------

router.get("/plugins", pluginController.list);
router.get("/tools", pluginController.tools);
router.post("/tools/:id/execute", pluginController.execute);

// ---- Forge (Damar bikin tool sendiri / editor manual) ---------

router.get("/forge", forgeController.list);
router.post("/forge", forgeController.create);
router.get("/forge/:id", forgeController.read);
router.post("/forge/:id/approve", forgeController.approve);
router.post("/forge/:id/reject", forgeController.reject);
router.delete("/forge/:id", forgeController.remove);

// ---- Home automation -------------------------------------------

router.get("/home/status", homeController.status);
router.get("/home/config", homeController.config);
router.post("/home/config", homeController.saveConfig);
router.get("/home/devices", homeController.devices);
router.post("/home/control", homeController.control);
// CCTV Home Assistant: daftarnya, dan gambarnya diteruskan daemon
// supaya token HA tidak ikut ke renderer.
router.get("/home/cameras", homeController.cameras);
router.get("/home/camera/:id/snapshot", homeController.cameraSnapshot);

// MQTT: broker, discovery perangkat, kendali langsung command topic.
router.get("/home/mqtt/status", homeController.mqttStatus);
router.post("/home/mqtt/config", homeController.mqttConfig);
router.post("/home/mqtt/connect", homeController.mqttConnect);
router.post("/home/mqtt/disconnect", homeController.mqttDisconnect);
router.post("/home/mqtt/publish", homeController.mqttPublish);

// ---- Vision ----------------------------------------------------

router.get("/vision/status", visionController.status);
router.get("/vision/config", visionController.config);
router.get("/vision/raw", visionController.rawFile);
// Proksi gambar Immich (daemon menambahkan x-api-key; <img> tak bisa).
router.get("/vision/immich", visionController.immichProxy);
router.post("/vision/config", visionController.saveConfig);
router.post("/vision/analyze", visionController.analyze);
router.get("/cameras", visionController.cameras);
router.post("/cameras", visionController.addCamera);
router.delete("/cameras/:id", visionController.removeCamera);
router.get("/cameras/:id/snapshot", visionController.snapshot);
router.post("/cameras/:id/see", visionController.seeCamera);

// ---- Orang & wajah (Immich + face-match) -----------------------

router.get("/people/status", peopleController.status);
router.post("/people/immich", peopleController.saveImmich);
router.post("/people/face", peopleController.saveFace);
router.get("/people", peopleController.people);
router.post("/people/search", peopleController.search);

// ---- Multi-agent orkestrasi ------------------------------------

router.get("/agents", orchestratorController.agents);
router.post("/orchestrate", orchestratorController.orchestrate);

// ---- Damar Lab (laboratorium kolaboratif) ---------------------------
const labController = require("../../../controllers/labController");
router.get("/lab/projects", labController.projectsList);
router.post("/lab/projects", labController.projectCreate);
router.get("/lab/projects/:id", labController.projectGet);
router.post("/lab/projects/:id/activate", labController.projectPhase); // kompat v1
router.patch("/lab/projects/:id", labController.projectUpdate);
router.delete("/lab/projects/:id", labController.projectRemove);
router.get("/lab/projects/:id/browse", labController.projectBrowse);
router.post("/lab/projects/:id/vscode", labController.projectOpenVSCode);
router.get("/lab/projects/:id/timeline", labController.projectTimeline);
router.post("/lab/projects/:id/phase", labController.projectPhase);
router.post("/lab/projects/:id/memory", labController.memoryRemember);
router.get("/lab/projects/:id/memory", labController.memoryRecall);
router.get("/lab/projects/:id/memory/summary", labController.memorySummary);
router.post("/lab/projects/:id/knowledge", labController.knowledgeIngest);
router.post("/lab/projects/:id/snapshots", labController.snapshotCreate);
router.get("/lab/projects/:id/snapshots", labController.snapshotsList);
router.get("/lab/missions", labController.missionsList);
router.post("/lab/missions", labController.missionCreate);
router.get("/lab/missions/:id", labController.missionGet);
router.post("/lab/missions/:id/run", labController.missionRun);
// Terapkan hasil misi ke Damar utama (memori / Beranda / misi lanjutan / kode).
router.post("/lab/missions/:id/apply", labController.missionApply);
router.post("/lab/missions/:id/status", labController.missionTransition);
router.post("/lab/missions/:id/resume", labController.missionResume);
router.get("/lab/activity", labController.activityList);
router.get("/lab/agents", labController.agentsBoard);
router.get("/lab/instruments", labController.instrumentsList);

// Graf koding dari graphify (visualisasi struktur repo).
const graphController = require("../../../controllers/graphController");
router.get("/graph/coding", graphController.coding);
router.get("/lab/artifacts", labController.artifactsList);
router.post("/lab/artifacts", labController.artifactCreate);
router.get("/lab/decisions", labController.decisionsList);
router.post("/lab/decisions", labController.decisionCreate);
router.get("/lab/experiments", labController.experimentsList);
router.post("/lab/experiments", labController.experimentCreate);
router.post("/lab/experiments/:id/run", labController.experimentRun);
router.post("/lab/tests", labController.testRun);

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
router.post("/roles", roleController.saveConfig);

// ---- Proaktif (brief terjadwal) --------------------------------

router.get("/automation/status", automationController.status);
router.post("/automation/config", automationController.saveConfig);
router.post("/automation/run", automationController.run);

// ---- WhatsApp --------------------------------------------------

router.get("/whatsapp/status", whatsappController.status);
router.get("/whatsapp/groups", whatsappController.groups);
router.post("/whatsapp/config", whatsappController.saveConfig);
router.post("/whatsapp/connect", whatsappController.connect);
router.post("/whatsapp/logout", whatsappController.logout);
router.post("/whatsapp/test", whatsappController.test);

router.get("/telegram/status", telegramController.status);
router.post("/telegram/config", telegramController.saveConfig);
router.post("/telegram/test", telegramController.test);
router.post("/telegram/reconnect", telegramController.reconnect);

// ---- Kanal & sesi percakapan persisten --------------------------

router.get("/channels", channelController.list);
router.get("/channels/sessions", channelController.sessions);
router.delete("/channels/sessions/:key", channelController.clearSession);

// ---- MCP: kelola server eksternal + status ekspos ----------------

router.get("/mcp/servers", mcpController.list);
router.post("/mcp/servers", mcpController.save);
router.delete("/mcp/servers/:id", mcpController.remove);
router.post("/mcp/restart", mcpController.restart);

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

router.post("/companion/pair", companionController.request);
router.get("/companion/list", companionController.list);
router.get("/companion/qr", companionController.qr);
router.post("/companion/:id/revoke", companionController.revoke);

// ---- Integrasi eksternal ---------------------------------------

router.get("/integrations", integrationController.list);
router.post("/integrations/check", integrationController.checkAll);
router.post("/integrations/:id/check", integrationController.check);
router.patch("/integrations/:id", integrationController.update);
router.get("/integrations/:id/models", integrationController.models);

// ---- Memori jangka panjang -------------------------------------

router.get("/memory/stats", memoryController.stats);
router.get("/memory", memoryController.list);
router.post("/memory", memoryController.remember);
router.post("/memory/recall", memoryController.recall);
router.post("/memory/consolidate", memoryController.consolidate);
router.get("/memory/embeddings", memoryController.embeddingStatus);
router.post("/memory/embeddings/backfill", memoryController.backfill);

router.get("/memory/entities", memoryController.entities);
router.post("/memory/entities", memoryController.createEntity);
router.get("/memory/entities/:id", memoryController.entity);
router.patch("/memory/entities/:id", memoryController.updateEntity);
router.delete("/memory/entities/:id", memoryController.removeEntity);

router.get("/memory/documents", memoryController.documents);
router.post("/memory/documents", memoryController.ingest);
router.post("/memory/upload", memoryController.upload);
router.get("/memory/documents/:id/chunks", memoryController.documentChunks);
router.delete("/memory/documents/:id", memoryController.removeDocument);

// Governance: proposal memori ask-tier + audit. Sebelum "/memory/:id".
router.get("/memory/proposals", memoryController.proposals);
router.post("/memory/proposals/:id/approve", memoryController.approveProposal);
router.post("/memory/proposals/:id/reject", memoryController.rejectProposal);
router.get("/memory/audit", memoryController.audit);

// Rute ber-parameter ditaruh paling akhir agar tidak menelan
// "/memory/entities" dan kawan-kawan.
router.get("/memory/:id", memoryController.get);
router.patch("/memory/:id", memoryController.update);
router.delete("/memory/:id", memoryController.forget);

// ---- Suara (STT) -----------------------------------------------

router.get("/voice/status", voiceController.status);
router.get("/voice/config", voiceController.config);
router.get("/voice/voices", voiceController.voices);
router.post("/voice/config", voiceController.saveConfig);
router.post("/voice/transcribe", voiceController.transcribe);
router.post("/voice/speak", voiceController.speak);

// Crypto (Binance): config + uji koneksi untuk panel Settings.
const cryptoController = require("../../../controllers/cryptoController");
router.get("/crypto/config", cryptoController.config);
router.post("/crypto/config", cryptoController.saveConfig);
router.get("/crypto/status", cryptoController.status);

// Sajikan media terunduh (mp4) untuk <video> Console. Auth via header
// atau ?token= (lihat middleware auth) sebab elemen <video> tak bisa
// mengirim header Authorization.
const mediaController = require("../../../controllers/mediaController");
router.get("/media/:id", mediaController.serve);

// ---- Perangkat (mic / kamera / sensor) -------------------------

router.get("/devices", deviceController.get);
router.put("/devices", deviceController.update);
router.post("/devices/sensors", deviceController.addSensor);
router.delete("/devices/sensors/:id", deviceController.removeSensor);
router.get("/devices/sensors/readings", deviceController.readSensors);

// ---- Kebocoran Data (gratis, tanpa key) ---------------------------

router.post("/osint/breach", osintController.breachCheck);
router.post("/osint/breach/summary", osintController.breachSummary);

// ---- Telepon Intelijen (mitigasi penipuan) ------------------------

router.post("/osint/phone/analyze", osintController.phoneAnalyze);
router.post("/osint/phone/assess", osintController.phoneAssess);
router.post("/osint/phone/blacklist/add", osintController.phoneBlacklistAdd);
router.post("/osint/phone/blacklist/remove", osintController.phoneBlacklistRemove);
router.post("/osint/phone/whitelist/add", osintController.phoneWhitelistAdd);
router.get("/osint/phone/list", osintController.phoneList);

// ---- Pelacakan Orang (opt-in) --------------------------------------

router.get("/osint/track/list", osintController.personList);
router.post("/osint/track/register", osintController.personRegister);
router.post("/osint/track/update", osintController.personUpdate);
router.get("/osint/track/:id", osintController.personDetail);
router.post("/osint/track/:id/revoke", osintController.personRevoke);
router.post("/osint/track/geofence", osintController.personGeofenceAdd);
router.get("/osint/track/geofence/list", osintController.personGeofenceList);
router.get("/osint/track/geofence/:id/check", osintController.personGeofenceCheck);
router.get("/osint/track/nearby", osintController.personNearby);

// ---- OSINT (investigasi & detektif digital) ---------------------

router.post("/osint/investigate", osintController.investigate);
router.post("/osint/email", osintController.email);
router.post("/osint/username", osintController.username);
router.post("/osint/domain", osintController.domain);
router.get("/osint/platforms", osintController.platforms);

router.post("/osint/cases", osintController.caseCreate);
router.get("/osint/cases", osintController.caseList);
router.get("/osint/cases/:id", osintController.caseDetail);
router.post("/osint/cases/:id/findings", osintController.caseAddFinding);
router.post("/osint/cases/:id/evidence", osintController.caseAddEvidence);
router.post("/osint/cases/:id/close", osintController.caseClose);
router.delete("/osint/cases/:id", osintController.caseDelete);
router.get("/osint/cases/:id/export", osintController.caseExport);

// ---- Social Intelligence -------------------------------------------

router.post("/osint/social/bot", osintController.socialBot);
router.post("/osint/social/comments", osintController.socialComments);
router.post("/osint/social/location", osintController.socialLocation);
router.post("/osint/social/network", osintController.socialNetwork);
router.post("/osint/hoax/check", osintController.hoaxCheck);
router.post("/osint/hoax/trace", osintController.hoaxTrace);

// ---- NAS (penyimpanan & host, data nyata) ----------------------

router.get("/nas/status", nasController.status);
router.get("/nas/config", nasController.config);
router.post("/nas/config", nasController.setConfig);
router.get("/nas/immich", nasController.immichStatus);
router.post("/nas/immich/up", nasController.immichUp);
router.post("/nas/immich/down", nasController.immichDown);
router.get("/nas/pools", nasController.pools);
router.get("/nas/backup", nasController.backups);
router.post("/nas/backup", nasController.addBackup);
router.post("/nas/backup/:id/run", nasController.runBackup);
router.delete("/nas/backup/:id", nasController.removeBackup);
router.post("/nas/notify/test", nasController.testNotify);
router.post("/nas/monitor/check", nasController.monitorCheck);

// ---- Files (penjelajah berkas lokal, read-only) ----------------

router.get("/files", filesController.list);

// ---- Cuaca & profil (dashboard) --------------------------------

router.get("/ai/usage", aiController.usage);

router.get("/weather", personalController.weather);
router.post("/weather/config", personalController.weatherConfig);
router.get("/profile", personalController.profile);
router.post("/profile", personalController.saveProfile);

module.exports = router;
