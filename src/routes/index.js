const express = require("express");
const systemController = require("../controllers/systemController");
const AppError = require("../errors/AppError");

const apiV1 = require("./api/v1");

const router = express.Router();


router.get("/", systemController.home);

router.get("/health", systemController.health);

// Halaman web untuk device tertaut (companion) — dibuka dari HP/laptop.
router.get("/companion", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(require("../companion/deviceWeb").html());
});

router.get("/error", (req, res, next) => {
  next(new AppError("Testing Global Error Handler", 500));
});

router.use("/api/v1", apiV1);

module.exports = router;