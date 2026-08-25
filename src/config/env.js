require("dotenv").config({
    // Env SHELL menang atas .env — dotenv tidak boleh menimpa
    // AETHER_ROLE/PORT yang sudah diset pemakai (mis. AETHER_ROLE=cli).
    override: false
});

/**
 * Port default per peran — Console & CLI boleh berjalan BERSAMAAN
 * sebagai daemon terpisah di mesin yang sama:
 *
 *   AETHER_ROLE=console → 3000   (daemon penuh + Console desktop)
 *   AETHER_ROLE=cli     → 3001   (daemon untuk sesi CLI)
 *   (tanpa peran)       → 3000   (perilaku lama)
 *
 * Prioritas: PORT eksplisit > peran > .env.
 */
const role = String(process.env.AETHER_ROLE || "").toLowerCase();

const defaultPort =
    process.env.PORT && !(role === "cli" && process.env.PORT === "3000")
    ? process.env.PORT
    : (role === "cli" ? 3001 : Number(process.env.PORT || 3000));

module.exports = {
  port: Number(defaultPort),
  role,
  appName: process.env.APP_NAME || "Aether",
  version: process.env.APP_VERSION || "0.1.0",
  environment: process.env.NODE_ENV || "development"
};