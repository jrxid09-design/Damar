const express = require("express");
const response = require("../../../utils/response");
const systemController = require("../../../controllers/systemController");

const router = express.Router();
const { chatValidation } = require("../../../validators/chatValidator");
const validate = require("../../../middleware/validate");

const chatController = require("../../../controllers/chatController");
const sessionController = require("../../../controllers/sessionController");

// Bidang kendali yang dipakai Aether Console (aplikasi desktop).
router.use("/console", require("./console"));

// Device tertaut (companion) — pakai tools/skill Aether dari device lain.
router.use("/companion", require("./companion"));

router.get("/debug/messages", sessionController.debug);

router.get("/sessions", sessionController.getAll);

router.get(
  "/sessions/:sessionId",
  sessionController.getMessages
);

router.delete(
  "/sessions/:sessionId",
  sessionController.delete
);

router.post(
  "/chat",
  chatValidation,
  validate,
  chatController.chat
);

router.get("/", (req, res) => {
  response.success(res, "Aether API v1");
});

router.get("/version", systemController.version);

module.exports = router;