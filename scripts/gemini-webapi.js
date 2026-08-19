#!/usr/bin/env node
/**
 * Jalankan jembatan GeminiWebApi (ntthanh2603/gemini-web-to-api) —
 * Gemini web → API OpenAI-compatible yang DUKUNG GAMBAR.
 *
 *   node scripts/gemini-webapi.js          # start/restart kontainer
 *   node scripts/gemini-webapi.js stop     # hentikan
 *
 * Butuh 2 cookie dari gemini.google.com (F12 → Application → Cookies):
 *   __Secure-1PSID   → GEMINI_1PSID
 *   __Secure-1PSIDTS → GEMINI_1PSIDTS
 * Taruh di .env. Setelah jalan, pilih provider "GeminiWebApi" di
 * Console → Settings (endpoint http://localhost:4981/openai/v1).
 */
try { require("dotenv").config(); } catch { /* dotenv opsional */ }

const { execFileSync } = require("node:child_process");

const IMAGE = "ghcr.io/ntthanh2603/gemini-web-to-api:latest";
const NAME = "gemini-web-to-api";
const PORT = process.env.GEMINI_WEBAPI_PORT || "4981";

function docker(args, opts = {}) {
    return execFileSync("docker", args, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit", ...opts });
}

function stop() {
    try { docker(["rm", "-f", NAME], { quiet: true }); console.log(`Kontainer ${NAME} dihentikan.`); }
    catch { console.log("Tak ada kontainer berjalan."); }
}

function start() {

    const psid = process.env.GEMINI_1PSID;
    const psidts = process.env.GEMINI_1PSIDTS;

    if (!psid || !psidts) {
        console.error(
            "GEMINI_1PSID / GEMINI_1PSIDTS belum diset.\n" +
            "Ambil dari gemini.google.com (F12 → Application → Cookies):\n" +
            "  __Secure-1PSID   → GEMINI_1PSID\n" +
            "  __Secure-1PSIDTS → GEMINI_1PSIDTS\n" +
            "Taruh di .env lalu jalankan lagi."
        );
        process.exit(1);
    }

    try { docker(["version"], { quiet: true }); }
    catch { console.error("Docker tidak tersedia. Nyalakan Docker Desktop dulu."); process.exit(1); }

    // Buang kontainer lama (kalau ada) supaya cookie/port terbarui.
    try { docker(["rm", "-f", NAME], { quiet: true }); } catch { /* belum ada */ }

    console.log(`Menarik & menjalankan ${IMAGE} di port ${PORT} …`);
    docker([
        "run", "-d",
        "-p", `${PORT}:4981`,
        "-e", `GEMINI_1PSID=${psid}`,
        "-e", `GEMINI_1PSIDTS=${psidts}`,
        "--restart", "unless-stopped",
        "--name", NAME,
        IMAGE
    ]);

    console.log(
        `\nGeminiWebApi jalan di http://localhost:${PORT}/openai/v1\n` +
        "Pilih provider \"GeminiWebApi\" di Console → Settings, lalu kirim gambar."
    );
}

if (process.argv[2] === "stop") stop();
else start();
