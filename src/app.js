const express = require("express");
const path = require("path");

const pluginLoader = require("./plugins/pluginLoader");

// Load semua plugin
pluginLoader.load(
    path.join(__dirname, "plugins")
);

// Tampilkan plugin/tool yang berhasil di-load
require("./bootstrap/tools")();

const routes = require("./routes");

const app = express();

const errorHandler = require("./errors/errorHandler");

app.use(require("./middleware/cors"));

// Batas dinaikkan karena frame kamera dikirim sebagai base64
// untuk keperluan vision.
app.use(express.json({ limit: "25mb" }));

app.use("/api/v1/console", require("./middleware/auth"));

app.use("/", routes);

// Endpoint MCP (Model Context Protocol) — ekspos tool Aether ke klien
// MCP mana pun (Claude Desktop, agen lain, penghuni koloni). Tool
// destruktif disembunyikan kecuali AETHER_MCP_ALLOW_DESTRUCTIVE=1.
require("./mcp").attachMcp(app);

// Endpoint OpenAI-compatible (/v1/chat/completions) — jembatan otak
// Aether untuk klien OpenAI, terutama penghuni koloni AetherGenesis
// (Nyx, Viel, NODEK-01) lewat aether-entities/lib/mind.js. Otak penuh:
// system prompt, memori, keadaan batin, tool-calling loop.
app.use("/v1", require("./routes/v1openai"));

const response = require("./utils/response");

app.use((req, res) => {
    response.error(res, "Route not found", 404);
});

app.use(errorHandler);

module.exports = app;
