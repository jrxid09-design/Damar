const express = require("express");
const response = require("../../../utils/response");
const systemController = require("../../../controllers/systemController");

const router = express.Router();
const { chatValidation } = require("../../../validators/chatValidator");
const validate = require("../../../middleware/validate");

const sessionController = require("../../../controllers/sessionController");
const { rejectLegacyActionMiddleware } = require("../../../manager/legacyBoundary");

// Bidang kendali yang dipakai Damar Console (aplikasi desktop).
router.use("/console", require("./console"));

// Device tertaut (companion) — pakai tools/skill Damar dari device lain.
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
  rejectLegacyActionMiddleware("legacy agent chat")
);

router.get("/", (req, res) => {
  response.success(res, "Damar API v1");
});

router.get("/version", systemController.version);

module.exports = router;
