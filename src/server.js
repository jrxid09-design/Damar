require("./events/listeners/loggerListener");

// Argumen eksplisit menang atas .env — diproses SEBELUM config/env
// dibaca. Dipakai launcher/CLI untuk daemon per-peran:
//   node src/server.js --role cli   → port 3001 (bersamaan 3000)
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--role" && process.argv[i + 1]) {
        process.env.AETHER_ROLE = process.argv[++i];
    }
    else if (process.argv[i] === "--port" && process.argv[i + 1]) {
        process.env.PORT = process.argv[++i];
    }
}

const app = require("./app");
const config = require("./config/env");
const logger = require("./utils/logger");

const startup = require("./bootstrap/startup");

const telemetry = require("./services/telemetryService");
const aiRuntime = require("./services/aiRuntimeService");
const memory = require("./memory/services/MemoryService");
const whatsapp = require("./services/whatsappService");
const automation = require("./services/automationService");
const terminals = require("./runtime/terminal/TerminalRuntime");
const { manager: integrations } = require("./integrations");

const host = process.env.HOST ?? "0.0.0.0";

let server = null;
let shuttingDown = false;

/**
 * Menyiapkan subsistem SETELAH server berhasil listen.
 *
 * Semua di sini dibungkus try/catch masing-masing: kegagalan AI,
 * memori, atau integrasi tidak boleh menjatuhkan daemon —
 * bidang kendali tetap harus hidup untuk melapor apa yang rusak.
 */
function bootSubsystems() {

    startup(config);

    // Runtime otonom: capability sync, environment watch, housekeeping.
    require("./autonomy").init().catch(error => {
        logger.warn?.(`Autonomy runtime gagal disiapkan: ${error.message}`);
    });

    memory.start().catch(error => {
        telemetry.error(`Memori gagal disiapkan: ${error.message}`);
        logger.error(`Memori gagal disiapkan: ${error.message}`);
    });

    // Lapisan kesadaran: afek, perhatian, model-diri, metakognisi,
    // empati. Ia berlangganan bus telemetri, jadi harus hidup SEBELUM
    // subsistem lain mulai memancarkan peristiwa — kalau tidak, menit
    // pertama Aether berjalan tanpa keadaan batin sama sekali.
    try { require("./consciousness").start(); }
    catch (error) { telemetry.warn(`Kesadaran gagal disiapkan: ${error.message}`); }

    // Lapisan kanal: sesi percakapan persisten + registry WhatsApp/Telegram.
    try {
        const channels = require("./channels");
        channels.manager.register("whatsapp", whatsapp);
        channels.manager.register("telegram", require("./services/telegramService"));
        channels.manager.start().catch(error => {
            telemetry.warn(`Kanal gagal disiapkan: ${error.message}`);
        });
    }
    catch (error) {
        telemetry.warn(`Kanal gagal disiapkan: ${error.message}`);
    }

    // Otonomi: pulse (kesadaran diri), watchdog (penyembuh diri),
    // dream (konsolidasi mimpi jam 02:00). Semua gagal-anggun.
    try { require("./autonomy/pulse").start(); } catch (e) {
        telemetry.warn(`Pulse gagal: ${e.message}`);
    }
    try { require("./autonomy/watchdog").start(); } catch (e) {
        telemetry.warn(`Watchdog gagal: ${e.message}`);
    }
    try { require("./autonomy/dream").start(); } catch (e) {
        telemetry.warn(`Dream gagal: ${e.message}`);
    }

    // Voice runtime (always-on assistant). Nonaktif secara default; bila
    // diaktifkan dan gagal, daemon TETAP hidup — voice isolasi total.
    try {
        require("./voice").runtime.start().catch(error => {
            telemetry.warn(`Voice gagal disiapkan: ${error.message}`);
        });
    }
    catch (error) {
        telemetry.warn(`Voice gagal disiapkan: ${error.message}`);
    }

    try {
        aiRuntime.initialize();
    }
    catch (error) {
        telemetry.error(`AI runtime gagal disiapkan: ${error.message}`);
        logger.error(`AI runtime gagal disiapkan: ${error.message}`);
    }

    try {
        integrations.load().startPolling();

        integrations.on("integration:changed", snapshot => {
            telemetry.publish("integration:changed", snapshot);
        });
    }
    catch (error) {
        telemetry.error(`Integrasi gagal disiapkan: ${error.message}`);
        logger.error(`Integrasi gagal disiapkan: ${error.message}`);
    }

    // WhatsApp (nonaktif diam-diam bila belum tertaut / paket belum diinstall).
    whatsapp.start().catch(error => {
        telemetry.error(`WhatsApp gagal disiapkan: ${error.message}`);
    });

    // Telegram (nonaktif diam-diam bila token belum diatur).
    try {
        require("./services/telegramService").start().catch(error => {
            telemetry.warn(`Telegram gagal disiapkan: ${error.message}`);
        });
    }
    catch (error) {
        telemetry.warn(`Telegram gagal disiapkan: ${error.message}`);
    }

    // Lapisan proaktif: brief harian terjadwal (aktif bila diset di Settings).
    automation.start();

    // Terminal Runtime (pty persisten; nonaktif diam-diam bila node-pty belum ada).
    terminals.start();

    // Auto-monitor crypto: alarm harga di latar (data publik, tanpa proxy).
    try { require("./services/cryptoMonitorService").start(); }
    catch (error) { telemetry.warn(`[crypto] monitor gagal start: ${error.message}`); }

    // Bot trading: strategi sinyal di latar (auto-eksekusi opt-in).
    try { require("./services/cryptoBotService").start(); }
    catch (error) { telemetry.warn(`[crypto] bot gagal start: ${error.message}`); }

    // MQTT rumah: sambung broker bila sudah dikonfigurasi (discovery HA
    // + state realtime perangkat). Tanpa config = tetap diam.
    try {
        const mqttHome = require("./services/mqttService");
        if (mqttHome.configured) {
            mqttHome.connect().then(ok => {
                if (!ok) telemetry.warn(`[home] MQTT gagal: ${mqttHome.lastError ?? "tidak diketahui"}`);
            });
        }
    }
    catch (error) { telemetry.warn(`[home] MQTT init gagal: ${error.message}`); }

    // Auto-nyalakan runtime inti agar dashboard tak
    // "DEGRADED" tiap Aether dibuka. Ditunda agar terminal & health siap;
    // melewati yang sudah online. Bisa dimatikan di configs/runtimes.json.
    setTimeout(() => {
        try {
            require("./runtime/runtimeService").autostart()
                .catch(error => logger.warn?.(`Autostart runtime: ${error.message}`));
        }
        catch (error) { logger.warn?.(`Autostart runtime: ${error.message}`); }
    }, 4000).unref?.();

    // Gateway WebSocket khusus I/O terminal, menempel pada server HTTP yg sama.
    try {
        require("./ws/terminalGateway").attach(server);
    }
    catch (error) {
        logger.error(`Terminal gateway gagal: ${error.message}`);
    }

    if (!process.env.AETHER_TOKEN) {
        telemetry.warn(
            "AETHER_TOKEN belum diset — bidang kendali terbuka untuk siapa pun di jaringan ini."
        );
    }

    // Jejak audit disimpan 14 hari; yang lebih tua dibuang di sini
    // supaya tidak tumbuh selamanya (§96).
    try {
        require("./core/safety/auditTrail").prune();
    }
    catch (error) {
        logger.warn?.(`Pembersihan jejak audit: ${error.message}`);
    }

    // Rencana yang tertinggal berarti proses mati di tengah rantai
    // tool (§30). Dilaporkan, bukan dijalankan ulang diam-diam:
    // langkah berefek samping tidak boleh terulang tanpa sepengetahuan
    // pemilik (Konstitusi Pasal 2.1).
    try {

        const plans = require("./agent/planStore");

        plans.prune();

        const tersisa = plans.unfinished();

        if (tersisa.length) {
            telemetry.warn(
                `${tersisa.length} rencana tool terhenti di tengah jalan pada sesi sebelumnya — ` +
                `lihat data/plans/ (${tersisa.map(p => `${p.id.slice(0, 8)} ${p.progress.done}/${p.progress.total}`).join(", ")})`
            );
        }

    }
    catch (error) {
        logger.warn?.(`Pemeriksaan rencana tertunda: ${error.message}`);
    }

    logger.info(`Server listening on http://localhost:${config.port}`);
    logger.info(`Console API  : http://localhost:${config.port}/api/v1/console/overview`);

    // Banner ringkas & berwarna (senada CLI) supaya `npm start` mudah dibaca.
    try {
        const { c, symbols, hr } = require("./cli/theme");
        const base = `http://localhost:${config.port}`;
        const tokenLine = process.env.AETHER_TOKEN
            ? c.ok("aktif") : c.warn("terbuka — set AETHER_TOKEN untuk mengunci");
        console.log("\n" + hr(`Aether siap${config.role ? ` · ${config.role}` : ""}`));
        console.log(`  ${symbols.aether} Daemon       ${c.accent(base)}`);
        console.log(`  ${symbols.aether} Console API  ${c.muted(base + "/api/v1/console/overview")}`);
        console.log(`  ${symbols.aether} CLI          ${c.muted("npm run cli")}`);
        console.log(`  ${symbols.dot} Token        ${tokenLine}`);
        console.log(hr() + "\n");
    }
    catch { /* banner opsional */ }

}

/**
 * Jalankan daemon.
 *
 * Kegagalan listen (paling sering EADDRINUSE karena daemon lain
 * masih hidup) DULUNYA membuat proses mati dengan stack trace
 * tanpa penjelasan — inilah sumber utama "kadang jalan kadang
 * tidak". Sekarang error itu ditangkap dan dijelaskan.
 */
function listen(port, attemptsLeft = autoPortAttempts()) {

    server = app.listen(port, host);

    server.on("listening", () => {
        // Jika port digeser otomatis, pakai port final di seluruh app.
        config.port = server.address().port;
        bootSubsystems();
    });

    server.on("error", error => {

        if (error.code === "EADDRINUSE") {

            // Port dipakai proses lain. Sering kali itu justru daemon
            // Aether yang SUDAH jalan — bukan kesalahan fatal.
            if (attemptsLeft > 0) {

                const next = port + 1;

                logger.warn(
                    `Port ${port} sedang dipakai — mencoba ${next}...`
                );

                setTimeout(() => listen(next, attemptsLeft - 1), 150);

                return;

            }

            logger.error(
                `Port ${port} sedang dipakai dan tidak ada port pengganti.`
            );
            logger.error(
                "Kemungkinan Aether sudah berjalan. Pilihan:"
            );
            logger.error(
                `  • Sambungkan Console ke daemon yang sudah ada (http://localhost:${port}).`
            );
            logger.error(
                "  • Atau hentikan proses lama, lalu jalankan ulang."
            );
            logger.error(
                "    Windows : Get-Process node | Stop-Process -Force"
            );
            logger.error(
                "    Linux   : pkill -f 'node src/server.js'"
            );
            logger.error(
                "  • Atau pakai port lain: set PORT=3001 lalu jalankan lagi."
            );

            process.exit(1);

        }

        if (error.code === "EACCES") {

            logger.error(
                `Tidak diizinkan membuka port ${port}. Coba port di atas 1024.`
            );

            process.exit(1);

        }

        logger.error(`Gagal menjalankan server: ${error.message}`);

        process.exit(1);

    });

}

/**
 * Berapa kali menggeser port bila bentrok.
 *
 * Default 0 — lebih baik gagal dengan pesan jelas daripada diam-
 * diam pindah port dan bikin Console kehilangan daemon. Aktifkan
 * geser-otomatis hanya bila diminta lewat AETHER_PORT_AUTO.
 */
function autoPortAttempts() {

    return process.env.AETHER_PORT_AUTO === "1" ? 10 : 0;

}

const shutdown = (signal) => {

    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    logger.info(`${signal} diterima, menghentikan Aether...`);

    integrations.stopPolling();
    memory.stop();
    whatsapp.stop();
    try { require("./services/telegramService").stop(); } catch { /* abaikan */ }
    try { require("./channels").manager.stop(); } catch { /* abaikan */ }
    try { require("./voice").runtime.stop(); } catch { /* abaikan */ }
    try { require("./autonomy/pulse").stop(); } catch { /* abaikan */ }
    try { require("./autonomy/watchdog").stop(); } catch { /* abaikan */ }
    try { require("./autonomy/dream").stop(); } catch { /* abaikan */ }
    automation.stop();
    terminals.stop();
    try { require("./services/cryptoMonitorService").stop(); } catch { /* abaikan */ }
    try { require("./services/cryptoBotService").stop(); } catch { /* abaikan */ }
    try { require("./services/homeService").stopWatcher(); } catch { /* abaikan */ }
    try { require("./services/mqttService").disconnect(); } catch { /* abaikan */ }
    try { require("./consciousness").stop(); } catch { /* abaikan */ }

    if (server) {
        server.close(() => process.exit(0));
    }
    else {
        process.exit(0);
    }

    // Jangan menggantung selamanya kalau ada koneksi SSE yang
    // belum tertutup.
    setTimeout(() => process.exit(0), 5000).unref();

};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Sebuah promise yang gagal tanpa .catch DULUNYA bisa menjatuhkan
// proses di versi Node baru. Untuk daemon, lebih baik dicatat dan
// tetap hidup daripada mati mendadak di tengah malam.
process.on("unhandledRejection", (reason) => {
    const message = reason?.stack ?? reason?.message ?? String(reason);
    logger.error(`Unhandled rejection: ${message}`);
    telemetry.error(`Unhandled rejection: ${reason?.message ?? reason}`);
});

// Gangguan socket pada sambungan yang hidup lama (WhatsApp, MCP,
// keep-alive, integrasi) muncul sebagai error tanpa pemilik: tidak
// ada state aplikasi yang rusak, hanya koneksi yang putus dan akan
// tersambung lagi sendiri. Aether harus tetap hidup untuk itu.
const RECOVERABLE_NETWORK_ERRORS = new Set([
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ERR_STREAM_PREMATURE_CLOSE"
]);

// Exception tak tertangkap menandakan state mungkin sudah rusak.
// Dicatat lengkap lalu keluar tertib supaya manajer proses
// (pm2/systemd/Console) bisa menyalakan ulang dengan bersih —
// KECUALI bila penyebabnya sekadar koneksi terputus.
process.on("uncaughtException", (error) => {

    logger.error(`Uncaught exception: ${error.stack ?? error.message}`);
    telemetry.error(`Uncaught exception: ${error.message}`);

    if (RECOVERABLE_NETWORK_ERRORS.has(error?.code)) {

        logger.warn(
            `Koneksi terputus (${error.code}) — Aether tetap berjalan.`
        );

        return;

    }

    shutdown("uncaughtException");

});

listen(Number(config.port) || 3000);

module.exports = { app };
