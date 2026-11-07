// Ejaan lama AETHER_* diterima sebagai alias yang DEPRECATED; kunci
// kanonik DAMAR_* selalu menang. Dipanggil dua kali: sekali saat
// require (env SHELL), sekali lagi setelah .env dimuat.
const { applyEnvCompat } = require("./envCompat");

require("dotenv").config({
    // Env SHELL menang atas .env — dotenv tidak boleh menimpa
    // DAMAR_ROLE/PORT yang sudah diset pemakai (mis. DAMAR_ROLE=cli).
    override: false
});

applyEnvCompat();

/**
 * Port default per peran — Console & CLI boleh berjalan BERSAMAAN
 * sebagai daemon terpisah di mesin yang sama:
 *
 *   DAMAR_ROLE=console → 3000   (daemon penuh + Console desktop)
 *   DAMAR_ROLE=cli     → 3001   (daemon untuk sesi CLI)
 *   (tanpa peran)       → 3000   (perilaku lama)
 *
 * Prioritas: PORT eksplisit > peran > .env.
 */
const role = String(process.env.DAMAR_ROLE || "").toLowerCase();

const defaultPort =
    process.env.PORT && !(role === "cli" && process.env.PORT === "3000")
    ? process.env.PORT
    : (role === "cli" ? 3001 : Number(process.env.PORT || 3000));

module.exports = {
  port: Number(defaultPort),
  role,
  appName: process.env.APP_NAME || "Damar",
  version: process.env.APP_VERSION || "0.1.0",
  environment: process.env.NODE_ENV || "development"
};