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

// Permukaan Console: token = kredensial pemilik → peran superadmin
// HANYA setelah autentikasi sukses (identitas berprovenance dari
// tokenGuard; tanpa token permukaan terkunci — fail-closed C2).
const { tokenGuard } = require("./core/auth/tokenCompare");
// Owner Trust (Wave 5 Lane 4): mint per-request console provenance so the
// trust domain can authenticate the console surface from transport-owned
// evidence minted at real ingress (never from caller payloads).
const { ensureCanonicalComposed } = require("./authority/ownerTrustComposition");
const ownerTrustProvenance = (async () => {
    try {
        const comp = await ensureCanonicalComposed();
        return comp.ingress.consoleProvenanceMiddleware();
    } catch { return null; }
})();
app.use("/api/v1/console",
    (req, res, next) => {
        Promise.resolve(ownerTrustProvenance).then((mw) => {
            if (typeof mw === "function") return mw(req, res, next);
            next();
        }).catch(next);
    });
app.use("/api/v1/console",
    tokenGuard({ roleWhenAuthenticated: "superadmin", surface: "console" }));

app.use("/", routes);

// Endpoint MCP (Model Context Protocol) — ekspos tool Damar ke klien
// MCP mana pun (Claude Desktop, agen lain, penghuni koloni). Tool
// destruktif disembunyikan kecuali DAMAR_MCP_ALLOW_DESTRUCTIVE=1.
require("./mcp").attachMcp(app);

// Endpoint OpenAI-compatible (/v1/chat/completions) — jembatan otak
// Damar untuk klien OpenAI, terutama penghuni koloni AetherGenesis
// (Nyx, Viel, NODEK-01) lewat aether-entities/lib/mind.js. Otak penuh:
// system prompt, memori, keadaan batin, tool-calling loop.
app.use("/v1", require("./routes/v1openai"));

const response = require("./utils/response");

app.use((req, res) => {
    response.error(res, "Route not found", 404);
});

app.use(errorHandler);

module.exports = app;
