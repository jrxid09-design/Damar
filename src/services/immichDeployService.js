const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const nas = require("./nasService");
const telemetry = require("./telemetryService");

const pexec = promisify(execFile);

/**
 * immichDeployService — MEMASANG & mengelola Immich sebagai container
 * (berbeda dari immichService yang MEMAKAI Immich lewat API).
 *
 * Immich berjalan via Docker Compose. Aether menulis .env dari disk pool
 * pilihan pengguna lalu menyalakan/mematikan stack. Tanpa Docker (mis.
 * laptop dev) status ditandai unavailable — bukan error fatal. Data
 * (foto/video + DB) di <pool>/immich, ikut disk NAS, bukan di repo.
 */

const DIR = path.join(__dirname, "..", "..", "deploy", "immich");
const COMPOSE = path.join(DIR, "docker-compose.yml");
const URL = "http://localhost:2283";
const OPTS = { timeout: 12000, windowsHide: true, maxBuffer: 1024 * 1024, cwd: DIR };

function dataRoot() {
    const pool = nas.config().pool;
    return pool ? path.join(pool, "immich") : path.join(DIR, "data");
}

/**
 * Lokasi library foto. Default ikut disk pool, tapi bisa diarahkan
 * ke disk lain lewat configs/nas.json -> immich.libraryPath.
 *
 * Berguna saat foto tidak muat (atau tidak pantas) di disk pool:
 * library tumbuh sampai ratusan GB, sedangkan database kecil dan
 * lebih suka spindle sendiri supaya tidak berebut I/O dengan
 * penulisan foto.
 */
function libraryRoot() {
    const custom = nas.config().immich?.libraryPath;
    return custom ? String(custom) : path.join(dataRoot(), "library");
}

/**
 * Folder foto lama yang dipasang hanya-baca di /mnt/external,
 * bahan untuk External Library (diindeks di tempat, tidak disalin).
 *
 * Selalu terisi supaya compose tidak pernah kekurangan variabel;
 * tanpa setelan khusus ia menunjuk ke dataRoot yang pasti ada.
 */
function externalRoot() {
    const custom = nas.config().immich?.externalPath;
    return custom ? String(custom) : dataRoot();
}

const dockerPath = p => p.replace(/\\/g, "/");   // Docker Windows suka forward-slash

function writeEnv() {
    const c = nas.config();
    const root = dataRoot();
    const library = libraryRoot();
    fs.mkdirSync(library, { recursive: true });
    fs.mkdirSync(path.join(root, "postgres"), { recursive: true });
    fs.writeFileSync(path.join(DIR, ".env"),
        `UPLOAD_LOCATION=${dockerPath(library)}\n` +
        `EXTERNAL_LOCATION=${dockerPath(externalRoot())}\n` +
        `DB_DATA_LOCATION=${dockerPath(path.join(root, "postgres"))}\n` +
        `DB_PASSWORD=${c.immich.dbPassword}\n` +
        `DB_USERNAME=postgres\n` +
        `DB_DATABASE_NAME=immich\n` +
        `IMMICH_VERSION=release\n` +
        `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jakarta"}\n`, "utf8");
    return root;
}

function parsePs(stdout) {
    const t = stdout.trim();
    if (!t) return [];
    if (t.startsWith("[")) return JSON.parse(t);
    return t.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

async function status() {
    const root = dataRoot();
    const poolSet = Boolean(nas.config().pool);
    try {
        const { stdout } = await pexec("docker", ["compose", "-f", COMPOSE, "ps", "--format", "json"], OPTS);
        const services = parsePs(stdout).map(s => ({ name: s.Service || s.Name, state: s.State || s.Status || "" }));
        const running = services.filter(s => /running|up|healthy/i.test(s.state)).length;
        return { available: true, poolSet, installed: services.length > 0, running, services, url: URL, dataRoot: root, libraryRoot: libraryRoot() };
    }
    catch {
        return { available: false, poolSet, installed: false, running: 0, services: [], reason: "Docker tidak tersedia atau belum berjalan.", url: URL, dataRoot: root, libraryRoot: libraryRoot() };
    }
}

/** Pasang/nyalakan (pull + up -d) di latar; kembali segera (pull bisa lama). */
function up() {
    if (!nas.config().pool) throw new Error("Pilih disk pool NAS dulu sebelum memasang Immich.");
    writeEnv();
    const p = spawn("docker", ["compose", "-f", COMPOSE, "up", "-d"], { cwd: DIR, windowsHide: true, detached: true, stdio: "ignore" });
    p.on("error", e => telemetry.warn(`[immich] up gagal: ${e.message}`));
    p.unref();
    telemetry.info("[immich] menyalakan stack (docker compose up -d)…");
    return { starting: true, note: "Immich sedang disiapkan (unduh image bisa beberapa menit). Pantau status." };
}

async function down() {
    await pexec("docker", ["compose", "-f", COMPOSE, "down"], { ...OPTS, timeout: 60000 });
    return { stopped: true };
}

module.exports = { status, up, down, dataRoot, libraryRoot, externalRoot };
