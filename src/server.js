require("./events/listeners/loggerListener");

// Alias env lama AETHER_* -> DAMAR_* (deprecated; kanonik = DAMAR_*).
require("./config/envCompat");

// Argumen eksplisit menang atas .env — diproses SEBELUM config/env
// dibaca. Dipakai launcher/CLI untuk daemon per-peran:
//   node src/server.js --role cli   → port 3001 (bersamaan 3000)
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--role" && process.argv[i + 1]) {
        process.env.DAMAR_ROLE = process.argv[++i];
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

const {
    LIFECYCLE_STATES,
    getLifecycleState,
    setLifecycleState,
    transitionLifecycle,
    isAdmissionAllowed,
    resetServerLifecycleForTesting,
    resetLifecycleStateForTesting: resetLifecycleStateHelper,
    parseShutdownTimeoutMs,
    SHUTDOWN_TIMEOUT_MIN_MS,
    SHUTDOWN_TIMEOUT_MAX_MS,
    SHUTDOWN_TIMEOUT_DEFAULT_MS
} = require("./serverLifecycle");

let server = null;
let activeShutdownPromise = null;

function resetLifecycleStateForTesting(state = LIFECYCLE_STATES.BOOTING) {
    activeShutdownPromise = null;
    resetLifecycleStateHelper(state);
}

/**
 * Menyiapkan subsistem SETELAH server berhasil listen.
 *
 * Semua di sini dibungkus try/catch masing-masing: kegagalan AI,
 * memori, atau integrasi tidak boleh menjatuhkan daemon —
 * bidang kendali tetap harus hidup untuk melapor apa yang rusak.
 */
async function bootSubsystems() {

    // Initialize runtime memory DB & schema migrations first so all backing tables exist
    try {
        await memory.start();
    } catch (error) {
        telemetry.error?.(`Memori gagal disiapkan: ${error.message}`);
        logger.error?.(`Memori gagal disiapkan: ${error.message}`);
    }

    // Compose canonical authority before any lazy Manager/action client can
    // observe the production singleton.  A caller must receive either the
    // real durable composition or the already-composed fail-closed state;
    // construction-order races must not create a private deny-only island.
    try {
        const comp = await require("./authority/productionComposition").ensureProductionAuthorityComposed();
        const status = comp.status();
        logger.info?.(`[authority] kanonik siap: authorityBound=${status.authorityBound} ` +
            `ownerTrust=${status.ownerTrustComposed} owner=${status.ownerEnrolled}`);
    }
    catch (error) {
        logger.error?.(`Komposisi otoritas/owner-trust gagal (fail-closed): ${error.message}`);
    }

    let canonicalHost = null;
    try {
        const { ensureCanonicalRuntimeHost } = require("./runtime/host/runtimeHost");
        canonicalHost = await ensureCanonicalRuntimeHost({
            coreOptions: {
                enableManagerIngress: true
            }
        });
        logger.info?.(`[host] RuntimeHost kanonik siap: phase=${canonicalHost.phase}`);
    } catch (error) {
        logger.error?.(`RuntimeHost boot gagal: ${error.message}`);
    }

    try {
        await require("./integration/riProductionComposition").ensureRuntimeIntegrationComposed({
            host: canonicalHost
        });
        logger.info?.("[ri] Runtime Integration (UIX-W5) siap");
    } catch (error) {
        logger.warn?.(`Runtime Integration composition gagal: ${error.message}`);
    }

    startup(config);

    // R5-03: REAL PRODUCTION OWNER-TRUST PROVISIONING. Bind the canonical
    // AuthorityRegistry into the module-private distributed authority source
    // AND compose the sealed canonical Owner/Admin trust domain, so governed
    // distributed execution + Owner-ratified evolution resolve against a real
    // canonical owner instead of fail-closing on an unbound source. Boot stays
    // graceful: a composition fault is logged, fail-closed, and never crashes
    // the daemon.
    // Runtime otonom: capability sync, environment watch, housekeeping.
    require("./autonomy").init().catch(error => {
        logger.warn?.(`Autonomy runtime gagal disiapkan: ${error.message}`);
    });

    // Lapisan kesadaran: afek, perhatian, model-diri, metakognisi,
    // empati. Ia berlangganan bus telemetri, jadi harus hidup SEBELUM
    // subsistem lain mulai memancarkan peristiwa — kalau tidak, menit
    // pertama Damar berjalan tanpa keadaan batin sama sekali.
    try { require("./consciousness").start(); }
    catch (error) { telemetry.warn(`Kesadaran gagal disiapkan: ${error.message}`); }

    // Lapisan kanal: sesi percakapan persisten + registry WhatsApp/Telegram.
    // Setiap service dibungkus ingress adapter Owner Trust (Wave 5 Lane 4):
    // provenance peer di-mint dari konteks transport asli saat trafik datang
    // (OT-006) — ID mentah dari payload pesan tidak pernah jadi bukti.
    try {
        const channels = require("./channels");
        const { ensureCanonicalComposed } = require("./authority/ownerTrustComposition");
        ensureCanonicalComposed().then((comp) => {
            channels.manager.register("whatsapp", comp.ingress.attachWhatsappIngress({ service: whatsapp }));
            channels.manager.register("telegram", comp.ingress.attachTelegramIngress({ service: require("./services/telegramService") }));
        }).catch(error => {
            // Fail-open untuk TRANSPORT (chat tetap jalan); trust tetap tertutup
            // karena tanpa provenance yang di-mint tidak ada yang bisa bind/auth.
            telemetry.warn(`Ingress provenance gagal disiapkan: ${error.message}`);
            channels.manager.register("whatsapp", whatsapp);
            channels.manager.register("telegram", require("./services/telegramService"));
        });
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

    // Mata Dewa: kecerdasan spasial tertanam (headless core). Boot gagal-
    // anggun — kegagalan provider menurunkan status, bukan menjatuhkan Damar.
    // Provider berkunci (PLUS/PRO) terdaftar tapi jujur "credentials_absent"
    // sampai pemilik memasangnya via vault (data/mataDewa/credentials.json,
    // di-ignore — tidak pernah di-commit).
    try {
        const mataDewa = require("./mataDewa");
        const service = mataDewa.getService({
            credentialsFilePath: require("path").join(process.cwd(), "data", "mataDewa", "credentials.json"),
            // MD-001: publisher perintah UI visual-only terikat pada aliran
            // event Damar yang sudah ada (telemetryService → SSE Console).
            telemetry: telemetry
        });
        require("./mataDewa/providers").registerKeylessProviders(service);
        service.registerKeyedProviders();
        service.start().catch(error => {
            telemetry.warn(`Mata Dewa gagal disiapkan: ${error.message}`);
        });
        // Lane 5 integrasi (post-Lane4): jembatan trust kanonik dipasang
        // SETELAH komposisi OwnerTrust tersertifikasi selesai (async). Boot
        // tetap graceful — kegagalan integrasi menurunkan status (fail
        // closed), bukan menjatuhkan Damar. Sebelum jembatan terpasang,
        // semua permukaan berotorisasi Mata Dewa tetap menolak
        // (OWNER_TRUST_NOT_INTEGRATED / RF_DEVICE_GATE_NOT_COMPOSED).
        require("./authority/ownerTrustComposition").ensureCanonicalComposed()
            .then((comp) => {
                const { buildMataDewaTrustBridges, attachMataDewaTrustBridges } = require("./mataDewa/trust/composition");
                const bridges = buildMataDewaTrustBridges(comp);
                attachMataDewaTrustBridges(service, bridges);
                telemetry.info?.("Mata Dewa: jembatan trust kanonik terpasang (post-Lane4)");
            })
            .catch((error) => {
                telemetry.warn(`Mata Dewa: jembatan trust kanonik gagal terpasang (fail-closed): ${error.message}`);
            });
    }
    catch (error) {
        telemetry.warn(`Mata Dewa gagal disiapkan: ${error.message}`);
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
    // "DEGRADED" tiap Damar dibuka. Ditunda agar terminal & health siap;
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

    if (!process.env.DAMAR_TOKEN) {
        telemetry.warn(
            "DAMAR_TOKEN belum diset — bidang kendali terbuka untuk siapa pun di jaringan ini."
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
        const tokenLine = process.env.DAMAR_TOKEN
            ? c.ok("aktif") : c.warn("terbuka — set DAMAR_TOKEN untuk mengunci");
        console.log("\n" + hr(`Damar siap${config.role ? ` · ${config.role}` : ""}`));
        console.log(`  ${symbols.damar} Daemon       ${c.accent(base)}`);
        console.log(`  ${symbols.damar} Console API  ${c.muted(base + "/api/v1/console/overview")}`);
        console.log(`  ${symbols.damar} CLI          ${c.muted("npm run cli")}`);
        console.log(`  ${symbols.dot} Token        ${tokenLine}`);
        console.log(hr() + "\n");
    }
    catch { /* banner opsional */ }

    setLifecycleState(LIFECYCLE_STATES.RUNNING);
}

/**
 * Jalankan daemon.
 *
 * Kegagalan listen (paling sering EADDRINUSE karena daemon lain
 * masih hidup) DULUNYA membuat proses mati dengan stack trace
 * tanpa penjelasan — inilah sumber utama "kadang jalan kadang
 * tidak". Sekarang error itu ditangkap dan dijelaskan.
 */
async function listen(port, attemptsLeft = autoPortAttempts()) {

    if (getLifecycleState() === LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL) {
        throw new Error("Cannot listen: server is in terminal failed shutdown state");
    }
    if (getLifecycleState() === LIFECYCLE_STATES.STOPPED) {
        throw new Error("Cannot listen: server is in terminal STOPPED state without fresh boot");
    }
    if (getLifecycleState() !== LIFECYCLE_STATES.BOOTING) {
        throw new Error(`Cannot listen: server is not in BOOTING state (current: ${getLifecycleState()})`);
    }

    activeShutdownPromise = null;

    // Compose authority before opening the socket. A listening server must
    // never expose a window in which Manager requests can race composition.
    try {
        await require("./authority/productionComposition").ensureProductionAuthorityComposed();
    }
    catch (error) {
        logger.error?.(`Komposisi otoritas awal gagal (fail-closed): ${error.message}`);
    }

    return new Promise((resolve) => {
        server = app.listen(port, host);

        server.on("listening", () => {
            // Jika port digeser otomatis, pakai port final di seluruh app.
            config.port = server.address().port;
            void bootSubsystems().catch((error) => {
                logger.error?.(`Boot subsystems failed closed: ${error.message}`);
            }).then(() => {
                resolve(server);
            });
        });

        server.on("error", error => {

            if (error.code === "EADDRINUSE") {

                // Port dipakai proses lain. Sering kali itu justru daemon
                // Damar yang SUDAH jalan — bukan kesalahan fatal.
                if (attemptsLeft > 0) {

                    const next = port + 1;

                    logger.warn(
                        `Port ${port} sedang dipakai — mencoba ${next}...`
                    );

                    setTimeout(() => {
                        listen(next, attemptsLeft - 1).then(resolve);
                    }, 150);

                    return;

                }

            logger.error(
                `Port ${port} sedang dipakai dan tidak ada port pengganti.`
            );
            logger.error(
                "Kemungkinan Damar sudah berjalan. Pilihan:"
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

    });

}

/**
 * Berapa kali menggeser port bila bentrok.
 *
 * Default 0 — lebih baik gagal dengan pesan jelas daripada diam-
 * diam pindah port dan bikin Console kehilangan daemon. Aktifkan
 * geser-otomatis hanya bila diminta lewat DAMAR_PORT_AUTO.
 */
function autoPortAttempts() {

    return process.env.DAMAR_PORT_AUTO === "1" ? 10 : 0;

}

const shutdown = (signal, { exit = true } = {}) => {

    if (activeShutdownPromise) {
        logger.warn?.(`[shutdown] Shutdown already in progress (${signal}), awaiting active shutdown promise...`);
        return activeShutdownPromise;
    }

    if (getLifecycleState() === LIFECYCLE_STATES.STOPPED) {
        return Promise.resolve({ success: true, phase: LIFECYCLE_STATES.STOPPED, errors: [] });
    }

    if (getLifecycleState() === LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL) {
        const terminalError = new Error(`Server is in terminal shutdown failure state: ${LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL}`);
        terminalError.code = "LIFECYCLE_TERMINAL_FAILURE";
        if (exit) {
            process.exit(1);
        }
        return Promise.reject(terminalError);
    }

    activeShutdownPromise = (async () => {
        transitionLifecycle(LIFECYCLE_STATES.SHUTTING_DOWN);
        logger.info(`${signal} diterima, menghentikan Damar...`);

        // Bounded termination fallback: ensure signal/exit shutdown cannot hang indefinitely
        const SHUTDOWN_TIMEOUT_MS = parseShutdownTimeoutMs();
        let forceExitTimer = null;
        if (exit) {
            forceExitTimer = setTimeout(() => {
                logger.error(`[shutdown] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing terminal exit`);
                process.exit(2);
            }, SHUTDOWN_TIMEOUT_MS);
            forceExitTimer.unref?.();
        }

        const errors = [];
        const attemptCleanup = async (name, fn) => {
            try {
                await fn();
            } catch (err) {
                const message = err?.message ?? String(err);
                logger.error?.(`[shutdown] Cleanup failed for ${name}: ${message}`);
                errors.push({ name, error: err });
            }
        };

        // Phase 1: Close HTTP server listener and stop accepting new external connections immediately
        let serverClosePromise = null;
        if (server) {
            await attemptCleanup("httpServerCloseIdle", () => {
                if (typeof server.closeIdleConnections === "function") {
                    server.closeIdleConnections();
                }
            });

            serverClosePromise = new Promise((resolve, reject) => {
                server.close((err) => {
                    if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
                        return reject(err);
                    }
                    resolve();
                });
            });
        }

        // Phase 2: Teardown background workers and communication channels
        await attemptCleanup("integrations", () => integrations.stopPolling());
        await attemptCleanup("whatsapp", () => whatsapp.stop());
        await attemptCleanup("telegram", () => {
            const telegramService = require("./services/telegramService");
            if (typeof telegramService?.stop === "function") telegramService.stop();
        });
        await attemptCleanup("channels", () => {
            require("./channels").manager.stop();
        });
        await attemptCleanup("voice", () => {
            require("./voice").runtime.stop();
        });
        await attemptCleanup("pulse", () => {
            require("./autonomy/pulse").stop();
        });
        await attemptCleanup("watchdog", () => {
            require("./autonomy/watchdog").stop();
        });
        await attemptCleanup("dream", () => {
            require("./autonomy/dream").stop();
        });
        await attemptCleanup("automation", () => automation.stop());
        await attemptCleanup("terminals", () => terminals.stop());
        await attemptCleanup("cryptoMonitor", () => {
            require("./services/cryptoMonitorService").stop();
        });
        await attemptCleanup("cryptoBot", () => {
            require("./services/cryptoBotService").stop();
        });
        await attemptCleanup("homeWatcher", () => {
            require("./services/homeService").stopWatcher();
        });
        await attemptCleanup("mqtt", () => {
            require("./services/mqttService").disconnect();
        });
        await attemptCleanup("consciousness", () => {
            require("./consciousness").stop();
        });
        await attemptCleanup("mataDewa", () => {
            const mataDewa = require("./mataDewa");
            const mdInstance = mataDewa.getService?.();
            if (mdInstance && typeof mdInstance.shutdown === "function") {
                mdInstance.shutdown();
            }
        });
        await attemptCleanup("authority", () => {
            const production = require("./authority/productionComposition").getProductionAuthorityComposition?.();
            if (production && typeof production.close === "function") {
                production.close();
            }
        });

        // Phase 3: Runtime Integration cleanup (subscribers, SSE connections, adapters)
        await attemptCleanup("ri", () => {
            const ri = require("./integration/riProductionComposition").getRuntimeIntegrationComposition();
            if (ri && typeof ri.cleanup === "function") ri.cleanup();
        });

        // Phase 4: Canonical RuntimeHost shutdown
        await attemptCleanup("runtimeHost", async () => {
            const host = require("./runtime/host/runtimeHost").getCanonicalRuntimeHost();
            if (host && typeof host.shutdown === "function") await host.shutdown();
        });

        // Phase 5: MemoryService stop
        await attemptCleanup("memory", () => memory.stop());

        // Phase 6: Finalize HTTP server drain
        await attemptCleanup("httpServerCloseAll", () => {
            if (server && typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
            }
        });
        await attemptCleanup("httpServer", async () => {
            if (serverClosePromise) {
                await serverClosePromise;
            }
            server = null;
        });

        if (forceExitTimer) {
            clearTimeout(forceExitTimer);
            forceExitTimer = null;
        }

        if (errors.length > 0) {
            transitionLifecycle(LIFECYCLE_STATES.SHUTDOWN_FAILED_TERMINAL);
            const summary = errors.map(e => `${e.name} (${e.error?.message ?? e.error})`).join("; ");
            const aggregateError = new Error(`Shutdown failed with ${errors.length} cleanup error(s): ${summary}`);
            aggregateError.errors = errors;
            aggregateError.code = "SHUTDOWN_CLEANUP_FAILED";
            logger.error?.(`[shutdown] ${aggregateError.message}`);

            if (exit) {
                process.exit(1);
            }
            throw aggregateError;
        }

        transitionLifecycle(LIFECYCLE_STATES.STOPPED);
        logger.info?.("[shutdown] Shutdown completed successfully.");

        if (exit) {
            process.exit(0);
        }

        return { success: true, phase: LIFECYCLE_STATES.STOPPED, errors: [] };
    })().finally(() => {
        activeShutdownPromise = null;
    });

    return activeShutdownPromise;
};

const handleSignal = async (signal) => {
    try {
        await shutdown(signal, { exit: true });
    } catch (error) {
        logger.error?.(`[signal] Fatal shutdown failure handling ${signal}: ${error.message}`);
        if (server) {
            try { server.close(); } catch { /* abaikan */ }
            server = null;
        }
        process.exit(1);
    }
};

process.on("SIGINT", () => { void handleSignal("SIGINT"); });
process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });

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
// tersambung lagi sendiri. Damar harus tetap hidup untuk itu.
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
            `Koneksi terputus (${error.code}) — Damar tetap berjalan.`
        );

        return;

    }

    void handleSignal("uncaughtException");

});

if (require.main === module) {
    listen(Number(config.port) || 3000);
}

module.exports = {
    app,
    get server() { return server; },
    bootSubsystems,
    shutdown,
    listen,
    handleSignal,
    getLifecycleState,
    transitionLifecycle,
    setLifecycleState,
    isAdmissionAllowed,
    LIFECYCLE_STATES,
    resetLifecycleStateForTesting,
    resetServerLifecycleForTesting: resetLifecycleStateForTesting,
    parseShutdownTimeoutMs,
    SHUTDOWN_TIMEOUT_MIN_MS,
    SHUTDOWN_TIMEOUT_MAX_MS,
    SHUTDOWN_TIMEOUT_DEFAULT_MS
};
