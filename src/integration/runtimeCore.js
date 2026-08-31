"use strict";

/**
 * RUNTIME CORE WAVE 2 — akar komposisi runtime foundations.
 *
 * Menyusun subsystem TERSERTIFIKASI Wave 2 di atas embodied core
 * Wave 1 (src/integration/embodiedCore.js) tanpa mengubah semantik:
 *
 *   Resource Governor   — pemilik KANONIK admission/lease/pressure
 *   Recovery Capsule    — pemilik KANONIK crash/restart continuity
 *   InteractionBus      — pemilik KANONIK interaction lifecycle
 *   Presence Runtime    — pemilik KANONIK representasi lifecycle
 *
 * HUKUM ARSITEKTURAL (load-bearing):
 *   - Interaction != Authority/Authentication/Actuation.
 *   - Presence != Authority/ExecutionPriority/Actuation: presence hanya
 *     MEREPRESENTASIKAN tekanan/degradasi via API Presence tersertifikasi.
 *   - Governor admission != authority; pressure != permission.
 *   - Recovery != realitas saat ini; restore tidak pernah keputusan
 *     otoritas dan tidak menghidupkan ulang pekerjaan NON_RESUMABLE.
 *   - Perekat ini TIDAK menambah aktuator, transport, atau timer.
 */

const os = require("node:os");
const { createEmbodiedCore } = require("./embodiedCore");
const governorMod = require("../runtime/resourceGovernor");
const recovery = require("../runtime/recovery");
const ib = require("../runtime/interactionBus");
const { createMediaSubsystem, takePrivatePorts } = require("../runtime/mediaIngress/subsystem");
const presence = require("../runtime/presence");
const path = require("node:path");

const VERSION = "2.0.0-wave2";

function defaultGovernorObserver() {
    return {
        observe() {
            const mem = process.memoryUsage();
            return {
                totalMemBytes: os.totalmem(),
                freeMemBytes: os.freemem(),
                rssBytes: mem.rss,
                heapUsedBytes: mem.heapUsed,
                heapLimitBytes: mem.heapLimit,
                externalBytes: mem.external,
                arrayBuffersBytes: mem.arrayBuffers,
                eventLoopLagMs: null
            };
        }
    };
}

/**
 * Susun runtime core. Semua dependensi eksplisit; setiap slot menerima
 * instance jadi ATAU primitif untuk membangunnya.
 */
async function createRuntimeCore({
    // ---- Wave 1 passthrough / injection ----
    wave1 = {},
    // ---- Resource Governor ----
    governor = null,
    governorConfig = {},
    governorObserver = null,
    governorClock = null,
    // ---- Presence ----
    presenceRuntime = null,
    presenceClock = null,
    presenceConfig = {},
    // ---- InteractionBus ----
    bus = null,
    busClock = null,
    busIdFactory = null,
    busBounds = undefined,
    mediaStorageRoot = path.join(os.homedir(), ".damar", "media-v1"),
    mediaLimits = undefined,
    enableManagerIngress = false,
    // ---- Recovery ----
    recoverySystem = null,
    generationLedger = null,
    statusTracker = null,
    recoveryConfigOverrides = {}
} = {}) {

    if (bus !== null) {
        throw new TypeError("canonical runtime owns the InteractionBus and MediaSubsystem");
    }

    // ---- Wave 1 canonical owners --------------------------------------
    const core = await createEmbodiedCore(wave1);

    // ---- Presence: pemilik KANONIK lifecycle representation -----------
    let rt = presenceRuntime;
    if (!rt) {
        rt = presence.createPresenceRuntime({
            clock: presenceClock ?? presence.createSystemClock(),
            config: presenceConfig
        });
    }
    const producers = {
        host: rt.registerProducer(presence.PRODUCER_KIND.HOST, "runtime-core"),
        interaction: rt.registerProducer(
            presence.PRODUCER_KIND.INTERACTION, "runtime-core"),
        resource: rt.registerProducer(
            presence.PRODUCER_KIND.RESOURCE_GOVERNOR, "runtime-core"),
        recovery: rt.registerProducer(
            presence.PRODUCER_KIND.RECOVERY, "runtime-core")
    };

    // Boot deterministik sampai DORMANT (murni state memori, tanpa
    // efek samping proses):
    const bootResult = rt.boot(producers.host);
    if (!bootResult.ok) {
        throw new Error(
            `RUNTIME CORE: presence boot gagal (${bootResult.code})`);
    }
    rt.markInitializing(producers.host);
    rt.markInitializationComplete(producers.host);

    // ---- Resource Governor: pemilik KANONIK resource admission --------
    const gov = governor ?? governorMod.createResourceGovernor({
        config: governorConfig,
        observer: governorObserver ?? defaultGovernorObserver(),
        clock: governorClock ?? undefined
    });

    // Inert pressure port (satu arah): rekomendasi governor dipetakan
    // HANYA menjadi representasi degradasi di Presence.
    const ports = governorMod.integrationPorts.createIntegrationPorts();
    ports.presenceRuntime.registerPressureListener((payload) => {
        for (const rec of payload.recommendations) {
            rt.reportDegradation({
                producer: producers.resource,
                kind: presence.DEGRADED_REASON.RESOURCE_PRESSURE,
                detail: `${rec.type ?? "PRESSURE"}`,
                cause: presence.CAUSE.DEPENDENCY_UNAVAILABLE
            });
        }
    });

    // ---- InteractionBus: pemilik KANONIK interaction lifecycle --------
    const mediaSubsystem = createMediaSubsystem({
        storageRoot: mediaStorageRoot,
        limits: mediaLimits
    });
    await mediaSubsystem.ready;
    const canonicalMediaPorts = takePrivatePorts(mediaSubsystem);
    let busInstance;
    const busMediaPorts = Object.freeze({
        bindAcceptedInteraction: (envelope) => canonicalMediaPorts.bindAcceptedInteraction(busInstance, envelope),
        issueScopedAccess: canonicalMediaPorts.issueScopedAccess,
        readScopedAccess: canonicalMediaPorts.readScopedAccess,
        releaseScopedAccess: canonicalMediaPorts.releaseScopedAccess,
        releaseTransient: canonicalMediaPorts.releaseTransient
    });
    busInstance = ib.createInteractionBus({
        clock: busClock ?? (() => Date.now()),
        idFactory: busIdFactory ?? ib.createCryptoIdFactory(),
        bounds: busBounds,
        mediaIngress: mediaSubsystem,
        mediaPorts: busMediaPorts
    });
    let channelIngress = null;
    if (!bus && enableManagerIngress) {
        const { createDamarManager } = require("../manager/bootstrap");
        channelIngress = require("../runtime/interactionBus/managerIngressInternal").createManagerInteractionIngress({
            bus: busInstance,
            manager: createDamarManager(),
            mediaSubsystem
        });
    }

    // ---- Recovery Capsule: pemilik KANONIK restart continuity ---------
    const system = recoverySystem ??
        recovery.checkpoint.createRecoverySystem(recoveryConfigOverrides);
    const ledger = generationLedger ?? new recovery.GenerationLedger();
    const tracker = statusTracker ?? new recovery.RecoveryStatusTracker();

    // ---- Port observasi satu arah (inert) -----------------------------

    /** Representasi tekanan resource sebagai degradasi Presence.
     * TIDAK mengubah authority, TIDAK membunuh pekerjaan. */
    function propagatePressureToPresence() {
        const status = gov.getResourceStatus();
        const band = status.pressureBand;
        if (band === "CRITICAL" || band === "HIGH") {
            const r = rt.reportDegradation({
                producer: producers.resource,
                kind: presence.DEGRADED_REASON.RESOURCE_PRESSURE,
                detail: `band:${band}`,
                cause: presence.CAUSE.DEPENDENCY_UNAVAILABLE
            });
            return { represented: true, band, result: r };
        }
        return { represented: false, band };
    }

    /** Shutdown deterministik: tanpa timer yang bocor. Idempoten. */
    let shutDown = false;
    function shutdown({ reason = "SHUTDOWN" } = {}) {
        if (!shutDown) {
            try {
                rt.requestShutdown(producers.host, reason);
            } catch {
                // runtime sudah destroyed / state terminal — tetap idempoten
            }
            rt.destroy();
            shutDown = true;
        }
        return Object.freeze({ shutDown: true, reason });
    }

    return Object.freeze({
        version: VERSION,

        // Wave 1 (referensi kanonik):
        wave1: core,

        // Wave 2 (pemilik kanonik):
        governor: gov,
        governorPorts: ports,
        presence: rt,
        presenceProducers: Object.freeze(producers),
        bus: busInstance,
        channels: channelIngress,
        media: Object.freeze({ getDiagnostics: mediaSubsystem.getDiagnostics }),
        recovery: Object.freeze({
            system, ledger, tracker,
            checkpoint: recovery.checkpoint,
            selector: recovery.selector,
            restoreApi: recovery.restore,
            classification: recovery.classification
        }),

        // Inert one-way integration ports:
        propagatePressureToPresence,
        shutdown
    });
}

module.exports = { createRuntimeCore, VERSION };
