"use strict";

/**
 * CANONICAL RUNTIME COMPOSITION — single lexical ownership boundary
 * (Wave 5 Lane 4, repair R9 / DSC-R8-001).
 *
 * This module is the ONE place where the RuntimeCore + RuntimeHost + Voice
 * continuity handshake exists.  Everything privileged — the RuntimeCore
 * composition payload ({ lifecycle, composition }), the canonical transport
 * bind (bindCanonicalTransportPeer), and Voice continuity activation — lives
 * ONLY in this module's lexical scope.  NONE of it is exported.
 *
 * LAW (load-bearing):
 *
 *   PUBLIC DEPENDENCY INJECTION IS UNTRUSTED.
 *   CUSTOM coreFactory != TRUSTED COMPOSITION.
 *   FUNCTION IDENTITY != AUTHORIZATION.
 *   CALLER coreOptions MUST NEVER RECEIVE TRUSTED CONTINUITY OBJECTS.
 *   VOICE STARTUP IS THE ONLY LEGITIMATE VOICE CONTINUITY ACTIVATION PATH.
 *   PRIVILEGED CONTINUITY STATE MUST REMAIN LEXICAL.
 *
 * The privileged RuntimeCore payload is delivered from
 * buildRuntimeCoreInternal to buildRuntimeHostInternal through a LEXICAL
 * callback (`onCompositionPayload`) that is a module-internal function
 * argument — NEVER a public option.  The public facades below
 * (createRuntimeCore / createRuntimeHost) NEVER install that callback for
 * any caller-controlled factory or caller-supplied coreOptions.
 *
 * This is a MOVE/BIND/REFACTOR of the existing single implementations from
 * src/integration/runtimeCore.js and src/runtime/host/runtimeHost.js.  There
 * is exactly ONE RuntimeCore, ONE RuntimeHost, ONE Manager, ONE
 * InteractionBus, ONE continuity store, and ONE VoiceRuntime.
 */

const os = require("node:os");
const path = require("node:path");

// RuntimeCore composition dependencies (moved from runtimeCore.js).
const { createEmbodiedCore } = require("./embodiedCore");
const governorMod = require("../runtime/resourceGovernor");
const recovery = require("../runtime/recovery");
const ib = require("../runtime/interactionBus");
const { createMediaSubsystem } = require("../runtime/mediaIngress/subsystem");
const presence = require("../runtime/presence");

// RuntimeHost composition dependencies (moved from runtimeHost.js).
const presenceMod = require("../runtime/presence");
const governorModHost = require("../runtime/resourceGovernor");
const ibHost = require("../runtime/interactionBus");
const { HostPhaseMachine, HOST_PHASE } = require("../runtime/host/phases");
const { HOST_COMMANDS, normalizeHostCommand } = require("../runtime/host/commands");
const { createTransportAdapter } = require("../runtime/host/transportAdapter");

// VoiceRuntime class dependencies (moved with the class from voiceRuntime.js).
// These are required DIRECTLY here (not via the voice facade), so no import
// cycle can form through the compatibility facade.  None of these voice
// subsystems require this composition module or runtimeHost.
const { EventEmitter } = require("node:events");
const telemetry = require("../services/telemetryService");
const { voiceConfig } = require("../voice/config");
const { StateMachine, STATES } = require("../voice/stateMachine");
const { VoiceSession } = require("../voice/voiceSession");
const { createWakeWordProvider } = require("../voice/providers/wakeWord");
const { ClapDetector } = require("../voice/providers/clapDetector");
const { AudioInput } = require("../voice/providers/audioInput");
const { AudioOutput } = require("../voice/providers/audioOutput");
const { VadDetector } = require("../voice/providers/vad");

const CORE_VERSION = "2.0.0-wave2";
const HOST_VERSION = "1.0.0-wave3";

const LOCAL_TRANSPORT_ID = "runtime.local";

let localSessionCounter = 0;

const DEFAULT_LOCAL_CAPABILITIES = Object.freeze({
    acceptsText: true,
    acceptsCommands: true,
    supportsCancellation: true,
    supportsApprovalResponses: true,
    acceptsAuthEvidence: true,
    acceptsEvents: true
});

function defaultClock() {
    return () => Date.now();
}

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

// ---------------------------------------------------------------------------
// PRIVILEGED OPTION SANITIZATION (DSC-R8-001).
//
// Fields that must NEVER flow into a caller-controlled factory or be honored
// from public caller options.  They are stripped before any caller-controlled
// `coreFactory` sees the options object.
// ---------------------------------------------------------------------------
const PRIVILEGED_CORE_OPTION_KEYS = Object.freeze([
    "trustedContinuitySink",
    "continuityComposition",
    "continuityLifecycle",
    "trustedSink",
    "binder",
    "activation",
    "continuityController",
    "continuityToken",
    "trustedResolver",
    "trustedToken",
    "bindCanonicalTransportPeer",
    "resolveContinuityId",
    "restoreContinuity",
    "flushContinuity",
    "shutdownContinuity",
    "continuityStatus"
]);

/** Return a copy of `options` with every privileged continuity key removed. */
function sanitizeCoreOptions(options) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
        return {};
    }
    const out = {};
    for (const key of Object.keys(options)) {
        if (!PRIVILEGED_CORE_OPTION_KEYS.includes(key)) {
            out[key] = options[key];
        }
    }
    return out;
}

/* ===========================================================================
 * RUNTIME CORE COMPOSITION (moved from src/integration/runtimeCore.js)
 * ========================================================================= */

/**
 * buildRuntimeCoreInternal(options, onCompositionPayload)
 *
 * The moved RuntimeCore composition.  `onCompositionPayload` is a LEXICAL
 * callback invoked with the trusted continuity payload ({ lifecycle,
 * composition }) when a manager-ingress continuity domain is composed.  It is
 * a module-internal argument — it is NEVER read from `options`, so no caller
 * can supply it through the public options bag.
 */
async function buildRuntimeCoreInternal({
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
    // ---- Session continuity (Wave 5 Lane 4, DSC-003) ----
    continuityStoreFile = undefined,
    // ---- Recovery ----
    recoverySystem = null,
    generationLedger = null,
    statusTracker = null,
    recoveryConfigOverrides = {}
} = {}, onCompositionPayload = null) {

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
    const mediaDomain = createMediaSubsystem({
        storageRoot: mediaStorageRoot,
        limits: mediaLimits,
        atomicDomain: true,
        busOptions: { clock: busClock ?? (() => Date.now()), idFactory: busIdFactory ?? ib.createCryptoIdFactory(), bounds: busBounds }
    });
    const mediaSubsystem = mediaDomain.media;
    await mediaSubsystem.ready;
    const busInstance = mediaDomain.bus;
    let channelIngress = null;
    if (!bus && enableManagerIngress) {
        channelIngress = require("../manager/bootstrap").createDamarManagerIngressDomain({
            bus: busInstance,
            mediaSubsystem,
            ...(continuityStoreFile === undefined ? {} : { continuityStoreFile })
        });
    }

    // ---- Recovery Capsule: pemilik KANONIK restart continuity ---------
    const system = recoverySystem ??
        recovery.checkpoint.createRecoverySystem(recoveryConfigOverrides);
    const ledger = generationLedger ?? new recovery.GenerationLedger();
    const tracker = statusTracker ?? new recovery.RecoveryStatusTracker();

    // ---- Port observasi satu arah (inert) -----------------------------

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

    // DSC-R8-001: the trusted continuity payload is delivered ONLY through
    // the LEXICAL `onCompositionPayload` callback supplied by
    // buildRuntimeHostInternal — NEVER through a public option.  When no
    // lexical callback exists (ordinary public createRuntimeCore), the
    // payload is NOT delivered to anyone.
    if (typeof onCompositionPayload === "function" && channelIngress) {
        onCompositionPayload(Object.freeze({
            lifecycle: channelIngress.lifecycle,
            composition: channelIngress.composition
        }));
    }

    return Object.freeze({
        version: CORE_VERSION,

        // Wave 1 (referensi kanonik):
        wave1: core,

        // Wave 2 (pemilik kanonik):
        governor: gov,
        governorPorts: ports,
        presence: rt,
        presenceProducers: Object.freeze(producers),
        bus: busInstance,
        channels: channelIngress ? channelIngress.channels : null,
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

/* ===========================================================================
 * RUNTIME HOST COMPOSITION (moved from src/runtime/host/runtimeHost.js)
 * ========================================================================= */

/**
 * buildRuntimeHostInternal(options, privileged)
 *
 * The moved RuntimeHost composition.  `privileged` is a LEXICAL struct that
 * is NEVER populated from public options:
 *
 *   privileged.voiceComposition === true — marks this host as the canonical
 *     Voice composition, so its lexical voice-activation closure is
 *     registered in the module-private CANONICAL_VOICE_ACTIVATION registry
 *     (reachable only by the lexical Voice composition).  Ordinary hosts pass
 *     no privileged struct and get NO activation capability.
 *
 * For an ordinary public host (privileged === null) the trusted payload is
 * captured ONLY into the host's own private closure (lifecycle/restore/
 * shutdown) and NEVER forwarded anywhere else.
 */
async function buildRuntimeHostInternal({
    coreOptions = {},
    coreFactory = null,
    conversationHandler = null,
    clock = defaultClock(),
    busBounds = undefined,
    localTransportId = LOCAL_TRANSPORT_ID
} = {}, privileged = null) {
    // DSC-R8-001: EVERY caller-supplied coreFactory is treated as untrusted.
    // Function identity is NOT a trust signal.  The canonical Voice
    // composition does NOT go through the public `coreFactory` boundary at
    // all — it uses the lexical `composeCanonicalVoiceHost` below, which
    // calls buildRuntimeCoreInternal DIRECTLY.
    const factory = coreFactory === null ? null : coreFactory;
    if (factory !== null && typeof factory !== "function") {
        throw new TypeError("HOST_CORE_FACTORY_INVALID");
    }
    if (conversationHandler !== null && typeof conversationHandler !== "function") {
        throw new TypeError("HOST_CONVERSATION_HANDLER_INVALID");
    }
    const isVoiceComposition = privileged !== null && privileged.voiceComposition === true;

    const phaseMachine = new HostPhaseMachine();

    // ------------------------------------------------------------ BOOT
    phaseMachine.transitionTo(HOST_PHASE.BOOTING, "host-boot");

    // ------------------------------------------------------- INITIALIZE
    phaseMachine.transitionTo(HOST_PHASE.INITIALIZING, "compose-runtime-core");
    // PRIVATE closure state for the trusted continuity lifecycle/composition
    // handles — delivered LEXICALLY by buildRuntimeCoreInternal, never via a
    // caller-controlled factory or public option.
    let continuityLifecycleHandles = null;

    // The host's own lexical payload sink: captures into host closure only.
    const onCompositionPayload = (handles) => {
        continuityLifecycleHandles = handles;
    };

    let core;
    if (factory === null) {
        // Canonical path: the host composes the RuntimeCore DIRECTLY through
        // the lexical internal builder.  The payload callback is lexical.
        // Manager ingress (and thus the channel continuity domain) is enabled
        // only when NO custom conversation handler is bound — matching the
        // canonical pre-refactor behavior so a custom conversationHandler is
        // the sole CONVERSATION route.
        core = await buildRuntimeCoreInternal({
            ...sanitizeCoreOptions(coreOptions),
            enableManagerIngress: conversationHandler === null
        }, onCompositionPayload);
    } else {
        // Caller-controlled factory: ALWAYS untrusted.  Pass SANITIZED
        // options ONLY — NO privileged sink, NO payload callback, NO
        // privileged keys.  The host does NOT install its lexical payload
        // callback into a caller-controlled factory, so the factory can
        // never receive the trusted composition payload.  Continuity
        // lifecycle is therefore host-owned only for the canonical direct
        // composition (factory === null); an untrusted core yields no
        // trusted continuity.
        const sanitized = sanitizeCoreOptions(coreOptions);
        if (conversationHandler === null) {
            sanitized.enableManagerIngress = true;
        }
        core = await factory(sanitized);
    }
    const rt = core.presence;
    const producers = core.presenceProducers;

    // ---------------------------------------------------------- RECOVER
    phaseMachine.transitionTo(HOST_PHASE.RECOVERING, "clean-recovery-start");
    const generationStart = core.recovery.ledger.advance("runtime-host-clean-start");
    core.recovery.tracker.recordRuntimeGeneration(generationStart.generationId);

    const recoveryPass = runPresenceRecoveryPass(rt, producers.recovery);
    if (!recoveryPass.ok) {
        phaseMachine.transitionTo(HOST_PHASE.FAILED, `recovery:${recoveryPass.code}`);
        return buildFailedHost({ phaseMachine, failureCode: recoveryPass.code });
    }

    // ---------------------------------------- CONTINUITY BOOT RESTORE (Lane 4)
    const continuityLifecycle = continuityLifecycleHandles ? continuityLifecycleHandles.lifecycle : null;
    if (continuityLifecycle && typeof continuityLifecycle.restoreContinuity === "function") {
        try {
            await continuityLifecycle.restoreContinuity();
        } catch {
            // Fail-closed degradation is decided inside the domain.
        }
    }

    phaseMachine.transitionTo(HOST_PHASE.READY, "ready-dormant");

    // ------------------------------------------------------------- BUS
    const bus = core.bus;
    bus.registerTransport({
        transportId: localTransportId,
        origin: "SYSTEM",
        capabilities: DEFAULT_LOCAL_CAPABILITIES
    });

    let shutDown = false;
    let shutdownRequestedAt = null;

    bus.registerHandler({
        route: "COMMAND",
        supportedKinds: ["COMMAND"],
        priority: 100,
        handler: (envelope, ctx) => handleControlInteraction(envelope, ctx)
    });

    bus.registerHandler({
        route: "STATUS",
        supportedKinds: ["STATUS_REQUEST"],
        priority: 100,
        handler: (envelope, ctx) => handleStatusInteraction(envelope, ctx)
    });

    if (conversationHandler !== null || !core.channels) {
        bus.registerHandler({
            route: "CONVERSATION",
            supportedKinds: ["MESSAGE", "CONTEXT_REFERENCE"],
            priority: 0,
            handler: conversationHandler ?? defaultConversationHandler
        });
    }

    async function handleControlInteraction(envelope, ctx) {
        const stream = ctx.stream;
        stream.emit("START", { interactionId: envelope.interactionId });
        const named = envelope.payload?.namedArguments ?? {};
        const command = normalizeHostCommand({
            command: envelope.payload?.command,
            reason: named.reason ?? null,
            source: named.source ?? envelope.provenance?.origin ?? "bus",
            requestId: named.requestId ?? null
        });
        if (!command.ok) {
            stream.emit("FINAL", { ok: false, code: command.code });
            stream.emit("COMPLETE", { interactionId: envelope.interactionId });
            return;
        }
        let outcome;
        switch (command.command) {
            case HOST_COMMANDS.SUMMON:
                outcome = host.summon({ source: command.source, reason: command.reason });
                break;
            case HOST_COMMANDS.DISMISS:
                outcome = host.dismiss({ source: command.source, reason: command.reason });
                break;
            case HOST_COMMANDS.STATUS:
                outcome = { ok: true, status: host.status() };
                break;
            case HOST_COMMANDS.SHUTDOWN:
                outcome = host.requestShutdown({
                    reason: command.reason ?? `command:${command.source}`
                });
                break;
            default:
                outcome = { ok: false, code: "COMMAND_UNKNOWN" };
        }
        stream.emit("FINAL", { command: command.command, ...summarize(outcome) });
        stream.emit("COMPLETE", { interactionId: envelope.interactionId });
    }

    async function handleStatusInteraction(envelope, ctx) {
        const stream = ctx.stream;
        stream.emit("START", { interactionId: envelope.interactionId });
        stream.emit("FINAL", { status: host.status() });
        stream.emit("COMPLETE", { interactionId: envelope.interactionId });
    }

    async function defaultConversationHandler(envelope, ctx) {
        const stream = ctx.stream;
        stream.emit("START", { interactionId: envelope.interactionId });
        const text = typeof envelope.payload?.text === "string"
            ? envelope.payload.text.slice(0, 200)
            : "";
        stream.emit("DELTA", { text: "" });
        stream.emit("FINAL", {
            text: "",
            note: "NO_CONVERSATION_HANDLER_BOUND",
            receivedChars: text.length
        });
        stream.emit("COMPLETE", { interactionId: envelope.interactionId });
    }

    function summarize(outcome) {
        if (outcome === null || typeof outcome !== "object") return { ok: Boolean(outcome) };
        return {
            ok: outcome.ok !== false,
            code: outcome.code ?? undefined,
            state: outcome.state ?? undefined,
            status: outcome.status
        };
    }

    // ------------------------------------------------- SUMMON / DISMISS
    function summon({ source = "api", reason = null } = {}) {
        if (!phaseMachine.isOperational()) {
            return { ok: false, code: "HOST_NOT_READY", phase: phaseMachine.phase };
        }
        const boundedReason = `[${String(source).slice(0, 64)}] ${reason === null ? "summon" : String(reason)}`;
        const result = rt.summon(producers.host, boundedReason.slice(0, 200));
        return { ...result, source };
    }

    function dismiss({ source = "api", reason = null } = {}) {
        if (!phaseMachine.isOperational()) {
            return { ok: false, code: "HOST_NOT_READY", phase: phaseMachine.phase };
        }
        const boundedReason = `[${String(source).slice(0, 64)}] ${reason === null ? "dismiss" : String(reason)}`;
        const result = rt.dismiss(producers.host, boundedReason.slice(0, 200));
        return { ...result, source };
    }

    // ------------------------------------------------------ ACTIVITIES
    function beginActivity(mode, options = {}) {
        if (!phaseMachine.isOperational()) {
            return { ok: false, code: "HOST_NOT_READY" };
        }
        return rt.beginActivity(mode, { producer: producers.host, ...options });
    }

    function endActivity(token, options = {}) {
        return rt.endActivity(token, options);
    }

    function recommendInterruption(token, options = {}) {
        return rt.recommendInterruption(token, options);
    }

    function reportDegradation(options = {}) {
        return rt.reportDegradation({ producer: producers.host, ...options });
    }

    function clearDegradation(options = {}) {
        return rt.clearDegradation(options);
    }

    // ---------------------------------------------------- HEALTH/STATUS
    function health() {
        const presenceStatus = safe(() => rt.getPresenceStatus());
        return {
            version: HOST_VERSION,
            phase: phaseMachine.phase,
            healthy: phaseMachine.isOperational() &&
                presenceStatus?.lifecycleState !== presenceMod.LIFECYCLE.FAILED &&
                !shutDown,
            generationId: core.recovery.ledger.current,
            presenceState: presenceStatus?.lifecycleState ?? null,
            pressureBand: safe(() => core.governor.getResourceStatus()?.pressureBand) ?? null
        };
    }

    function status() {
        return {
            version: HOST_VERSION,
            host: phaseMachine.snapshot(),
            generationId: core.recovery.ledger.current,
            generationHistoryCount: core.recovery.ledger.history.length,
            presence: safe(() => rt.getPresenceStatus()) ?? null,
            governor: safe(() => core.governor.getResourceStatus()) ?? null,
            bus: safe(() => bus.getStatus()) ?? null,
            recovery: safe(() => core.recovery.tracker.getRecoveryStatus()) ?? null,
            continuity: safe(() => (continuityLifecycle && typeof continuityLifecycle.continuityStatus === "function"
                ? continuityLifecycle.continuityStatus()
                : null)) ?? null,
            localTransport: localTransportId,
            shuttingDown: shutDown
        };
    }

    function safe(fn) {
        try { return fn(); } catch { return null; }
    }

    // ----------------------------------------------- TRANSPORT ADAPTERS
    const adapters = new Map();

    function attachTransportAdapter({ transportId, origin, capabilities, normalize }) {
        if (!phaseMachine.isOperational()) {
            return { ok: false, code: "HOST_NOT_READY" };
        }
        if (adapters.has(transportId)) {
            return { ok: false, code: "ADAPTER_ALREADY_ATTACHED" };
        }
        const adapter = createTransportAdapter({
            bus, transportId, origin, capabilities, normalize
        });
        adapters.set(transportId, adapter);
        return { ok: true, adapter };
    }

    function detachTransportAdapter(transportId) {
        const adapter = adapters.get(transportId);
        if (!adapter) return { ok: false, code: "ADAPTER_NOT_ATTACHED" };
        adapter.disconnect();
        adapters.delete(transportId);
        return { ok: true };
    }

    function getTransportAdaptersSnapshot() {
        return Object.freeze(
            [...adapters.values()].map((a) => a.snapshot())
        );
    }

    function activateCanonicalVoiceContinuity() {
        // Lifecycle-bound revocation (retained): fails closed once the
        // owning runtime is no longer operational.
        if (!phaseMachine.isOperational() || shutDown || phaseMachine.isTerminal()) {
            return Object.freeze({ ok: false, code: "HOST_NOT_OPERATIONAL", terminal: true });
        }
        const composition = continuityLifecycleHandles ? continuityLifecycleHandles.composition : null;
        if (!composition || typeof composition.bindCanonicalTransportPeer !== "function") {
            return Object.freeze({ ok: false, code: "TRANSPORT_PEER_SEAM_UNAVAILABLE" });
        }
        try {
            const result = composition.bindCanonicalTransportPeer("voice");
            return Object.freeze({ ok: true, ...result });
        } catch (error) {
            return Object.freeze({ ok: false, code: error?.code ?? "TRANSPORT_PEER_BIND_FAILED" });
        }
    }

    /** Honest per-transport continuity support verdict (safe diagnostic). */
    function transportContinuitySupport(channel) {
        const composition = continuityLifecycleHandles ? continuityLifecycleHandles.composition : null;
        if (!composition || typeof composition.transportSupport !== "function") {
            return { supported: false, scope: null, reason: "SEAM_UNAVAILABLE" };
        }
        return composition.transportSupport(channel);
    }

    function submitLocal(request) {
        const { sessionId, ...rest } = request ?? {};
        return bus.submit({
            transportId: localTransportId,
            ...rest,
            sessionId: sessionId ?? `ses_local-${++localSessionCounter}`
        });
    }

    // --------------------------------------------------------- SHUTDOWN
    function requestShutdown({ reason = "SHUTDOWN" } = {}) {
        if (shutdownRequestedAt === null) shutdownRequestedAt = clock();
        return shutdown(reason);
    }

    let shutdownCompletion = null;

    function whenShutdownSettled() {
        if (shutdownCompletion === null) return Promise.resolve(null);
        return shutdownCompletion;
    }

    function shutdown(reason = "SHUTDOWN") {
        if (shutdownCompletion !== null) {
            return buildShutdownResult(Object.freeze({ shutDown: true, idempotent: true, reason }), shutdownCompletion);
        }
        if (phaseMachine.isTerminal()) {
            shutDown = true;
            shutdownCompletion = Promise.resolve(null);
            return buildShutdownResult(Object.freeze({ shutDown: true, idempotent: true, reason }), shutdownCompletion);
        }
        shutDown = true;
        phaseMachine.transitionTo(HOST_PHASE.SHUTTING_DOWN, reason);

        for (const adapter of adapters.values()) {
            try { adapter.disconnect(); } catch { /* tetap lanjut */ }
        }
        adapters.clear();

        shutdownCompletion = (async () => {
            if (continuityLifecycle && typeof continuityLifecycle.shutdownContinuity === "function") {
                try {
                    return await continuityLifecycle.shutdownContinuity();
                } catch {
                    return Object.freeze({ failed: true, code: "FLUSH_CONTAINED" });
                }
            }
            return null;
        })();
        shutdownCompletion.catch(() => {});

        try {
            rt.requestShutdown(producers.host, String(reason).slice(0, 200));
        } catch { /* presence sudah terminal */ }
        try {
            rt.confirmOffline(producers.host);
        } catch { /* state tidak legal / sudah terminal */ }
        try {
            core.shutdown({ reason: String(reason).slice(0, 200) });
        } catch { /* core sudah shutdown */ }

        phaseMachine.transitionTo(HOST_PHASE.TERMINATED, "terminated");
        return buildShutdownResult(
            Object.freeze({ shutDown: true, idempotent: false, reason }),
            shutdownCompletion
        );
    }

    function buildShutdownResult(syncShape, completionPromise) {
        const result = Object.freeze({
            ...syncShape,
            get continuityFlush() { return completionPromise; },
            then(onFulfilled, onRejected) {
                return (async () => {
                    let flushed = null;
                    try {
                        flushed = await completionPromise;
                    } catch {
                        flushed = Object.freeze({ failed: true, code: "FLUSH_CONTAINED" });
                    }
                    return Object.freeze({ ...syncShape, continuityFlush: flushed });
                })().then(onFulfilled, onRejected);
            }
        });
        return result;
    }

    // ------------------------------------------------------- FAIL/RECOVER
    function fail({ reason = "FAIL" } = {}) {
        if (phaseMachine.isTerminal() || shutDown) {
            return { ok: false, code: "HOST_TERMINAL" };
        }
        const presenceResult = safePresence(() => rt.reportFatalFailure(producers.host, String(reason).slice(0, 200)));
        const phaseResult = phaseMachine.transitionTo(HOST_PHASE.FAILED, reason);
        return {
            ok: phaseResult.ok,
            code: phaseResult.ok ? "HOST_FAILED" : phaseResult.code,
            presence: presenceResult
        };
    }

    function recoverNow({ reason = "RECOVER" } = {}) {
        if (phaseMachine.isTerminal() || shutDown) {
            return { ok: false, code: "HOST_TERMINAL" };
        }
        if (phaseMachine.phase !== HOST_PHASE.FAILED && phaseMachine.phase !== HOST_PHASE.READY) {
            return { ok: false, code: "HOST_PHASE_ILLEGAL", phase: phaseMachine.phase };
        }

        if (
            phaseMachine.phase === HOST_PHASE.READY &&
            rt.lifecycleState !== presenceMod.LIFECYCLE.FAILED
        ) {
            phaseMachine.transitionTo(HOST_PHASE.RECOVERING, reason);
            const pass = runPresenceRecoveryPass(rt, producers.recovery);
            if (!pass.ok) {
                phaseMachine.transitionTo(HOST_PHASE.FAILED, `recover:${pass.code}`);
                return { ok: false, code: pass.code };
            }
            phaseMachine.transitionTo(HOST_PHASE.READY, "recovered");
            return { ok: true, generationId: core.recovery.ledger.current };
        }

        phaseMachine.transitionTo(HOST_PHASE.RECOVERING, reason);
        const gen = safePresence(() => rt.startNewGeneration(`host-recover:${reason}`));
        if (!gen?.ok) {
            phaseMachine.transitionTo(HOST_PHASE.FAILED, "recover:start-new-generation");
            return { ok: false, code: "PRESENCE_GENERATION_FAULT" };
        }
        try {
            const boot = rt.boot(producers.host);
            if (!boot.ok) throw new Error(boot.code ?? "BOOT_REJECTED");
            rt.markInitializing(producers.host);
            rt.markInitializationComplete(producers.host);
        } catch (error) {
            phaseMachine.transitionTo(HOST_PHASE.FAILED, `recover:${error.message}`);
            return { ok: false, code: "PRESENCE_REBOOT_FAULT" };
        }
        const ledgerGeneration = core.recovery.ledger.advance("runtime-host-recover");
        core.recovery.tracker.recordRuntimeGeneration(ledgerGeneration.generationId);
        const pass = runPresenceRecoveryPass(rt, producers.recovery);
        if (!pass.ok) {
            phaseMachine.transitionTo(HOST_PHASE.FAILED, `recover:${pass.code}`);
            return { ok: false, code: pass.code };
        }
        phaseMachine.transitionTo(HOST_PHASE.READY, "recovered-new-generation");
        return {
            ok: true,
            generationId: ledgerGeneration.generationId,
            presenceGeneration: gen.generation
        };
    }

    const host = Object.freeze({
        version: HOST_VERSION,

        get phase() { return phaseMachine.phase; },

        summon,
        dismiss,
        beginActivity,
        endActivity,
        recommendInterruption,
        reportDegradation,
        clearDegradation,

        attachTransportAdapter,
        detachTransportAdapter,
        getTransportAdaptersSnapshot,
        submitLocal,
        channels: core.channels,
        transportContinuitySupport,

        health,
        status,

        requestShutdown,
        shutdown,
        whenShutdownSettled,
        fail,
        recoverNow,

        core
    });

    // DSC-R8-001: the lexical voice-activation closure is registered in the
    // module-private CANONICAL_VOICE_ACTIVATION registry ONLY for the
    // canonical Voice composition.  It is NOT on the returned host facade,
    // host.core, or host.channels, and is reachable ONLY by the lexical
    // Voice composition (below) — an ordinary host holder can never reach it.
    if (isVoiceComposition) {
        CANONICAL_VOICE_ACTIVATION.set(host, activateCanonicalVoiceContinuity);
    }

    return host;
}

/** Pass recovery Presence kanonik: DORMANT → RECOVERING → DORMANT. */
function runPresenceRecoveryPass(rt, recoveryProducer) {
    try {
        const start = rt.requestRecovery(recoveryProducer, "host-startup-recovery-pass");
        if (!start.ok && start.code !== "OK_NOOP") {
            const state = rt.getPresenceStatus().state;
            if (state !== presenceMod.LIFECYCLE.RECOVERING) {
                return { ok: false, code: start.code ?? "RECOVERY_START_REJECTED" };
            }
        }
        const done = rt.completeRecovery(recoveryProducer, "host-startup-recovery-complete");
        if (!done.ok && done.code !== "OK_NOOP") {
            return { ok: false, code: done.code ?? "RECOVERY_COMPLETE_REJECTED" };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, code: error?.code ?? "RECOVERY_FAULT" };
    }
}

function safePresence(fn) {
    try { return fn(); } catch { return null; }
}

function buildFailedHost({ phaseMachine, failureCode }) {
    return Object.freeze({
        version: HOST_VERSION,
        get phase() { return phaseMachine.phase; },
        failed: true,
        failureCode,
        summon: () => ({ ok: false, code: "HOST_FAILED" }),
        dismiss: () => ({ ok: false, code: "HOST_FAILED" }),
        shutdown: () => Object.freeze({ shutDown: true, idempotent: false }),
        health: () => ({ phase: phaseMachine.phase, healthy: false, failureCode })
    });
}

/* ===========================================================================
 * CANONICAL VOICE COMPOSITION (lexical, never exported)
 * ========================================================================= */

// Module-private: host -> lexical voice-activation closure (set only for
// Voice-composed hosts).  NOT exported; NOT reachable by any module import.
const CANONICAL_VOICE_ACTIVATION = new WeakMap();

/**
 * LEXICAL, module-private: compose the canonical Voice host.  This is the
 * ONLY composition that receives a voice-activation capability.  It is NOT
 * exported and NOT reachable by an ordinary importer.  Returns the ordinary
 * host; the matching activation closure is retrieved ONLY through the
 * lexical `activateVoiceContinuity` below.
 */
async function composeCanonicalVoiceHost(coreOptions = {}) {
    const host = await buildRuntimeHostInternal({
        coreOptions: { ...sanitizeCoreOptions(coreOptions), enableManagerIngress: true },
        conversationHandler: null
    }, { voiceComposition: true });
    return host;
}

/**
 * LEXICAL, module-private: activate the canonical voice continuity identity
 * for the given Voice-composed host.  Zero identity input; returns inert
 * diagnostics ONLY ({ ok, code, ... }) — never a scope, handle, mint,
 * controller, domain, linker, secret, or capability object.  NOT exported.
 */
function activateVoiceContinuity(host) {
    const activate = host && typeof host === "object"
        ? CANONICAL_VOICE_ACTIVATION.get(host)
        : null;
    if (typeof activate !== "function") {
        return Object.freeze({ ok: false, code: "VOICE_ACTIVATION_UNAVAILABLE" });
    }
    return activate();
}

/* ===========================================================================
 * CANONICAL VoiceRuntime (class moved lexically — DSC-R9-001)
 * ========================================================================= */

// The VoiceRuntime class implementation lives HERE, in the SAME lexical
// module that owns buildRuntimeHostInternal / composeCanonicalVoiceHost /
// activateVoiceContinuity.  It closes over those private functions DIRECTLY
// — no privileged function is passed to any other module, and there is NO
// public/dynamic class-builder in the handoff path.  Replacing a public
// module in require.cache can therefore NEVER capture composeHost or
// activateVoice.
//
// The class is exported as a STABLE value (legitimate public product
// facade).  voice/voiceRuntime.js is a thin facade re-exporting it.

/** Module-private per-runtime composition state (instance -> { host }). */
const VOICE_COMPOSITION = new WeakMap();

class VoiceRuntime extends EventEmitter {

    constructor({ config = voiceConfig, session = null, interactionIngress = null } = {}) {

        super();
        this.setMaxListeners(20);

        this.cfg = typeof config === "function" ? config() : config;

        this.enabled = false;
        this.running = false;

        this.session = session ?? new VoiceSession({ interactionIngress });
        // DSC-R7-001/002: NO privileged state on own properties.  The
        // composed host and the activation capability live in the
        // module-private VOICE_COMPOSITION WeakMap (keyed by this instance)
        // — invisible to Object.keys / getOwnPropertyNames /
        // getOwnPropertySymbols over this instance.  A read-only prototype
        // getter below exposes the ORDINARY host facade (interaction only)
        // for application use.
        this._turnController = null;
        this._turnGeneration = 0;
        this._activeCapture = null;

        this.machine = new StateMachine((from, to) => {
            this.emit("state", { from, to });
            telemetry.publish("voice:state", { from, to });
        });

        this.wake = createWakeWordProvider({
            provider: this.cfg.wakeProvider,
            wakeWord: this.cfg.wakeWord
        });

        this.clap = new ClapDetector({
            threshold: this.cfg.clapThreshold,
            windowMs: this.cfg.clapWindowMs,
            minClapMs: this.cfg.clapMinClapMs,
            minGapMs: this.cfg.clapMinGapMs
        });

        this.input = new AudioInput({ backend: this._inputBackend() });
        this.output = new AudioOutput({ backend: this._outputBackend() });
        this.vad = new VadDetector({ vadTimeoutMs: this.cfg.vadTimeoutMs });

        // Timers & cancellation.
        this._timers = new Set();
        this._cancelled = false;
        this._speaking = false;
        this._levelStream = null;      // handle stream level audio standby
        this._lastVoiceAt = 0;         // RMS terakhir di atas ambang
        this._burstSeen = false;
        this._capturing = false;
        this._lastWakeTry = 0;
        this._autoReason = null;
        this.lastError = null;

    }

    _inputBackend() {
        // Backend audio dari env; default "cli" hanya bila diaktifkan
        // secara eksplisit, selain itu "none" (graceful).
        return process.env.DAMAR_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    /**
     * DSC-R7-001: read-only application-facing access to the ORDINARY host
     * facade (interaction only — no continuity administration, no
     * activation capability).  Returns null before start() / after stop().
     */
    get interactionHost() {
        const state = VOICE_COMPOSITION.get(this);
        return state ? state.host : null;
    }

    _outputBackend() {
        return process.env.DAMAR_VOICE_AUDIO_BACKEND === "cli" ? "cli" : "none";
    }

    // ---- Lifecycle -------------------------------------------------

    async start() {

        // "auto": aktif bila STT terkonfigurasi + perekam tersedia —
        // wake word mustahil tanpa keduanya; jujur daripada diam mati.
        let enabled = this.cfg.enabled;
        if (enabled === "auto") {
            const sttOk = require("../services/voiceService").sttConfigured;
            enabled = sttOk; // recorder diverifikasi setelah probe di bawah
            this._autoReason = sttOk ? null : "STT belum dikonfigurasi";
        }

        if (!enabled) {
            telemetry.info("[voice] nonaktif (DAMAR_VOICE_ENABLED=" +
                this.cfg.enabledRaw + ").");
            return this;
        }

        if (this.running) return this;

        this.running = true;
        this.enabled = true;

        // Probe perangkat (graceful: gagal pun tetap lanjut).
        await Promise.allSettled([this.input.probe(), this.output.probe()]);

        // auto tapi tak ada perekam → mati dengan alasan jelas.
        if (this.cfg.enabled === "auto" && !this.input.available) {
            this.enabled = false;
            this.running = false;
            this._autoReason = "perekam audio tidak tersedia";
            telemetry.info("[voice] auto-nonaktif: " + this._autoReason);
            return this;
        }

        if (!this.session.interactionIngress && typeof this.session.bindInteractionIngress === "function") {
            // DSC-R9-001 CANONICAL VOICE COMPOSITION (lexical): compose the
            // host through the module-private lexical canonical composition.
            // The host lives ONLY in the module-private WeakMap — never on
            // own properties, never exported.
            const host = await composeCanonicalVoiceHost({ enableManagerIngress: true });
            VOICE_COMPOSITION.set(this, Object.freeze({ host }));
            this.session.bindInteractionIngress(host.channels);
            // Activate the canonical voice continuity identity through the
            // module-private lexical closure.  Voice continuity is
            // DEVICE/RUNTIME-SCOPED (one local Damar owner per voice
            // runtime) — explicitly NOT physical-speaker identity.  Inert
            // diagnostics only.
            const bind = activateVoiceContinuity(host);
            if (!bind.ok) {
                // Fail closed: voice continuity simply stays unbound; the
                // ordinary ses_* interaction path continues.
                telemetry.info("[voice] continuity binding gagal: " + (bind.code ?? "unknown"));
            }
        }
        this.session.register();

        // Standby stream: RMS dari mic untuk (a) deteksi tepuk tangan,
        // (b) deteksi burst suara pemicu wake-word.
        this._startStandbyStream();

        telemetry.publish("voice:started", {
            wakeWord: this.cfg.wakeWord,
            clapEnabled: this.cfg.clapEnabled,
            mic: this.input.available,
            speaker: this.output.available
        });

        this.emit("started");

        // Mulai loop standby.
        this._loop().catch(error => {
            this.lastError = error.message;
            telemetry.warn(`[voice] loop berhenti: ${error.message}`);
        });

        return this;

    }

    /**
     * Stream level standby: satu sumber RMS untuk clap + burst-wake.
     * Hanya bekerja saat IDLE agar tidak mengganggu giliran aktif.
     */
    async _startStandbyStream() {

        if (!this.input.available) return;

        const stream = await this.input.startLevelStream((rms) => {

            var now = Date.now();
            if (rms > 0.055) this._lastVoiceAt = now;

            if (this.machine.current !== STATES.IDLE) return;

            if (this.cfg.clapEnabled) this.clapDetect(rms);

            // Detektor burst: suara di atas ambang = calon ucapan.
            if (rms > 0.055) {
                this._burstSeen = true;
            }
            // Setelah burst selesai (senyap 350ms) dan belum sedang merekam,
            // picu perekaman utterance untuk diperiksa wake word-nya.
            if (this._burstSeen && !this._capturing &&
                now - this._lastVoiceAt > 350 && now - (this._lastWakeTry || 0) > 2000) {
                this._burstSeen = false;
                this._lastWakeTry = now;
                this._wakeCycle().catch(err => {
                    this.lastError = err.message;
                });
            }

        });

        if (stream) {
            this._levelStream = stream;
            telemetry.info("[voice] standby stream aktif (wake word + tepuk).");
        }

    }

    async stop() {

        this.running = false;
        this._cancelActiveTurn();
        await this._finalizeCapture(this._activeCapture);

        for (const t of this._timers) clearTimeout(t);
        this._timers.clear();

        // Hentikan stream level audio standby.
        if (this._levelStream) {
            try { this._levelStream.stop(); } catch { /* abaikan */ }
            this._levelStream = null;
        }

        await this.output.stop();
        const state = VOICE_COMPOSITION.get(this);
        if (state) {
            const hostToStop = state.host;
            // DSC-R7-001: the capability is DESTROYED with its runtime — the
            // WeakMap entry is deleted so no activation primitive survives
            // the stop, even by instance reflection.
            VOICE_COMPOSITION.delete(this);
            // DSC-R1-005: await the durable continuity flush (and contain
            // any failure) before releasing the voice-owned host.
            try { await hostToStop.shutdown("voice-runtime-stop"); }
            catch { /* idempoten / contained */ }
        }
        this.machine.reset();

        telemetry.publish("voice:stopped", {});

        return this;

    }

    // ---- Loop utama ------------------------------------------------

    async _loop() {

        while (this.running) {

            // IDLE: standby (deteksi wake word saja). Selain IDLE:
            // poll cepat antar-tahapan. Tidak pernah memanggil LLM/STT di sini.
            const delay = this.machine.current === STATES.IDLE ? 250 : 50;

            await this._sleep(delay);

        }

    }

    _sleep(ms) {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this._timers.delete(t);
                resolve();
            }, ms);
            this._timers.add(t);
            t.unref?.();
        });
    }

    /**
     * Titik masuk dari luar: sebuah teks (mis. hasil STT ringan dari
     * wake-word provider, atau input programatik untuk tes).
     * Digunakan untuk DETEKSI wake word saat IDLE.
     *
     * @returns {object} { wake }
     */
    wakeDetect(text) {

        const r = this.wake.detect(text);

        if (r.detected) {
            this._onWake({ source: "wakeword", text: r.text });
        }

        return r;

    }

    /**
     * Siklus WAKE: utterance hasil burst → STT → cek wake word.
     * Bila terdeteksi: ack (dibicarakan dulu, agar capture berikutnya tak
     * menelan suara Damar sendiri) → lanjut siklus LISTEN perintah.
     */
    async _wakeCycle() {

        const turn = this._beginTurn();
        this._capturing = true;

        try {

            const buf = await this._captureUtterance(4000, { signal: turn.controller.signal });

            if (!buf || buf.length < 20000) return;   // < ~0.6s audio: buang

            const { text } = await this._transcribe(buf, { signal: turn.controller.signal });
            if (!text) return;

            const r = this.wake.detect(text);

            telemetry.publish("voice:wake-check", {
                text: text.slice(0, 60),
                detected: r.detected
            });

            if (!r.detected) return;   // percakapan orang lain — biarkan

            if (!this._ownsTurn(turn)) return;

            // ---- WAKE! ----
            this.machine.transit(STATES.WAKE_DETECTED);
            this.emit("wake", { source: "wakeword", text });
            telemetry.publish("voice:wake", { source: "wakeword", text });

            // Ack dibicarakan DULU (blocking) supaya mic berikutnya tidak
            // merekam suara Damar sendiri.
            await this.speak(this.cfg.acknowledgement, { signal: turn.controller.signal, generation: turn.generation });

            // Lalu buka sesi dengar untuk perintah.
            await this._listenCycle({ signal: turn.controller.signal, generation: turn.generation });

        }
        catch (error) {
            this.lastError = error.message;
            telemetry.warn(`[voice] wake cycle gagal: ${error.message}`);
        }
        finally {
            if (this._ownsTurn(turn)) {
                this._capturing = false;
                this.machine.reset();
            }
        }

    }

    /**
     * Siklus LISTEN: rekam perintah (maks maxListenMs, VAD senyap 1.2s)
     * → STT → THINKING→SPEAKING via handleTranscript.
     */
    async _listenCycle({ signal, generation = this._turnGeneration } = {}) {

        if (generation !== this._turnGeneration) return;
        this.machine.transit(STATES.LISTENING);
        setImmediate(() => {});   // biarkan transisi terserap

        const buf = await this._captureUtterance(this.cfg.maxListenMs || 8000, { signal, generation });

        if (generation !== this._turnGeneration) return;

        if (!buf || buf.length < 20000) {
            this.speak("Sepertinya tak ada perintah.").catch(() => {});
            if (generation === this._turnGeneration) this.machine.reset();
            return;
        }

        if (generation !== this._turnGeneration) return;
        this.machine.transit(STATES.TRANSCRIBING);

        const { text } = await this._transcribe(buf, { signal });

        if (generation !== this._turnGeneration) return;

        if (!text) {
            this.speak("Aku kurang menangkapnya.").catch(() => {});
            if (generation === this._turnGeneration) this.machine.reset();
            return;
        }

        await this.handleTranscript(text);   // THINKING→SPEAKING→IDLE di dalam

    }

    /**
     * Rekam satu utterance: mulai sekarang, berhenti lebih awal bila
     * senyap ≥1.2 dtk SETELAH ada suara, atau saat maxMs habis.
     */
    async _captureUtterance(maxMs = 4000, { signal, generation = this._turnGeneration } = {}) {

        const cap = await this.input.startCapture({ durationMs: maxMs + 1500 });

        if (!cap) return null;
        const capture = { cap, generation, finalized: false };
        this._activeCapture = capture;

        this._capturing = true;

        try {

            return await new Promise(resolve => {

                const startedAt = Date.now();
                var spoke = false;

                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearInterval(iv);
                    clearTimeout(safety);
                    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
                    this._finalizeCapture(capture).then(resolve).catch(() => resolve(null));
                };
                const iv = setInterval(() => {

                    var now = Date.now();
                    if (now - this._lastVoiceAt < 300) spoke = true;

                    var silence = now - this._lastVoiceAt;
                    var elapsed = now - startedAt;

                    if ((spoke && silence > 1200) || elapsed > maxMs) {
                        finish();
                    }

                }, 120);

                // Jaring pengaman
                const safety = setTimeout(finish, maxMs + 2500);
                safety.unref?.();
                const onAbort = signal ? finish : null;
                if (onAbort) {
                    signal.addEventListener("abort", onAbort, { once: true });
                    if (signal.aborted) onAbort();
                }

            });

        }
        finally {
            if (this._activeCapture === capture) {
                this._activeCapture = null;
                this._capturing = false;
            }
        }

    }

    /** STT via voiceService (faster-whisper dsb). Gagal → teks kosong. */
    async _transcribe(buf, { signal } = {}) {

        try {
            const voice = require("../services/voiceService");
            const r = await voice.transcribe(buf, {
                mimeType: "audio/wav",
                language: this.cfg.language || "id",
                localOnly: true,
                signal
            });
            return { text: (r.text || "").trim() };
        }
        catch (error) {
            this.lastError = error.message;
            telemetry.warn(`[voice] STT gagal: ${error.message}`);
            return { text: "" };
        }

    }
    /**
     * Trigger tepuk tangan 2x: beri sampel RMS lalu periksa double clap.
     */
    clapDetect(rms, t = Date.now()) {

        this.clap.feedLevel(rms, t);

        const r = this.clap.detect(t);

        if (r.detected) {
            this._onWake({ source: "clap", gapMs: r.gapMs });
        }

        return r;

    }

    /** Jalur bersama saat sebuah trigger wake terpicu (IDLE → WAKE). */
    _onWake({ source, text = null, gapMs = null }) {

        if (this.machine.current !== STATES.IDLE) return;

        this.machine.transit(STATES.WAKE_DETECTED);
        this.emit("wake", { source, text, gapMs });
        telemetry.publish("voice:wake", { source, text, gapMs });

        // Acknowledgement deterministik (tanpa LLM) — cepat.
        const turn = this._beginTurn();
        this._acknowledge(turn);

    }

    _acknowledge(turn) {
        // "Ya?" / "Siap." — deterministic, local, langsung.
        this.emit("ack", this.cfg.acknowledgement);
        telemetry.publish("voice:ack", { ack: this.cfg.acknowledgement });
        this.speak(this.cfg.acknowledgement, {
            signal: turn?.controller.signal,
            generation: turn?.generation
        }).catch(() => {});
    }

    // ---- Tahapan interaksi ----------------------------------------

    /**
     * Mulai mendengar (setelah wake). Biasanya dipicu otomatis oleh
     * acknowledgement; disediakan juga sebagai API untuk tes/integrasi.
     */
    async listen() {
        this.machine.transit(STATES.LISTENING);
        this.vad.start();
        this.emit("listening");
        return this;
    }

    /**
     * Terima transkrip (dari STT) dan jalankan putaran penuh:
     * THINKING → (tools) → SPEAKING.
     *
     * @param {string} transcript teks perintah
     * @returns {Promise<{ answer: string }>}
     */
    async handleTranscript(transcript) {

        const text = typeof transcript === "string" ? transcript.trim() : "";

        if (!text) return { answer: null, skipped: true };

        const { controller, generation } = this._beginTurn();
        if (this.machine.current !== STATES.THINKING) this.machine.transit(STATES.THINKING);

        try {

            const { answer } = await this.session.think(text, { signal: controller.signal });
            if (controller.signal.aborted || generation !== this._turnGeneration) return { answer: null, cancelled: true };

            this.machine.transit(STATES.SPEAKING);

            this.emit("answer", answer);
            telemetry.publish("voice:answer", { chars: answer.length });

            await this.speak(answer, { signal: controller.signal, generation });

            return { answer };

        }
        catch (error) {

            if (controller.signal.aborted || generation !== this._turnGeneration) return { answer: null, cancelled: true };
            this.lastError = error.message;
            telemetry.warn(`[voice] putaran gagal: ${error.message}`);
            if (this._ownsTurn({ controller, generation })) {
                this._turnController = null;
                this.machine.reset();
            }
            return { answer: null, error: error.message };

        }
        finally {
            // Kembali standby setelah selesai / gagal.
            if (this._ownsTurn({ controller, generation })) {
                this._turnController = null;
                this.machine.reset();
            }
        }

    }

    /**
     * Ucapkan teks lewat TTS (voiceService) lalu putar lewat AudioOutput.
     * Graceful: kegagalan TTS/speaker TIDAK melempar ke pemanggil loop.
     */
    async speak(text, { signal = null, generation = this._turnGeneration } = {}) {

        this._speaking = true;
        this._cancelled = false;

        try {

            const voice = require("../services/voiceService");

            // TTS streaming/chunked: voiceService.speak menghasilkan audio
            // utuh; di masa depan bisa di-chunk. Untuk sekarang, kita
            // putar hasilnya — dan barge-in bisa membatalkan pemutaran.
            const { audio } = await voice.speak(text, {
                voice: voice.ttsVoice,
                localOnly: true,
                signal
            });

            if (this._cancelled || signal?.aborted || generation !== this._turnGeneration) return;

            await this.output.play(audio);

        }
        catch (error) {
            // TTS/speaker gagal ≠ daemon mati. Catat, diam, lanjut.
            this.lastError = error.message;
            telemetry.warn(`[voice] TTS/putar gagal: ${error.message}`);
        }
        finally {
            this._speaking = false;
        }

    }

    /**
     * Barge-in: hentikan TTS, kembali ke LISTENING (atau IDLE).
     */
    async interrupt() {

        this._cancelled = true;
        this._cancelActiveTurn();
        await this._finalizeCapture(this._activeCapture);

        await this.output.stop();

        if (this.machine.current === STATES.SPEAKING) {
            this.machine.transit(STATES.LISTENING);
        }

        this.emit("interrupt");
        telemetry.publish("voice:interrupt", {});

    }

    _cancelActiveTurn() {
        this._turnGeneration += 1;
        if (this._turnController) this._turnController.abort();
        this._turnController = null;
    }

    _ownsTurn(turn) {
        return Boolean(turn) && turn.generation === this._turnGeneration &&
            this._turnController === turn.controller;
    }

    async _finalizeCapture(capture) {
        if (capture && typeof capture.stop === "function" && !capture.cap) {
            capture = { cap: capture, finalized: false };
            this._activeCapture = capture;
        }
        if (!capture || capture.finalized) return null;
        capture.finalized = true;
        try {
            return await capture.cap.stop();
        }
        finally {
            if (this._activeCapture === capture) {
                this._activeCapture = null;
                this._capturing = false;
            }
        }
    }

    _beginTurn() {
        this._cancelActiveTurn();
        const controller = new AbortController();
        const generation = ++this._turnGeneration;
        this._turnController = controller;
        return { controller, generation };
    }

    // ---- Status ----------------------------------------------------

    status() {

        const c = this.cfg;

        return {
            enabled: this.enabled,
            enabledRaw: c.enabledRaw,
            autoReason: this._autoReason,
            capturing: this._capturing,
            running: this.running,
            state: this.machine.current,
            wakeWord: c.wakeWord,
            clapEnabled: c.clapEnabled,
            clapDetector: this.clap.status(),
            clapStreamActive: Boolean(this._levelStream),
            microphone: this.input.status(),
            speaker: this.output.status(),
            sttProvider: c.sttProvider,
            ttsProvider: c.ttsProvider,
            wakeWordProvider: this.wake.status(),
            activeSession: this.machine.current !== STATES.IDLE
                ? this.machine.potret()
                : null,
            lastError: this.lastError
        };

    }

}

/* ===========================================================================
 * PUBLIC SAFE FACADES (no privileged primitives cross these boundaries)
 * ========================================================================= */

/**
 * createRuntimeCore(options) — ORDINARY public RuntimeCore factory.
 *
 * Sanitized: the public `trustedContinuitySink` option is REMOVED/IGNORED
 * (DSC-R8-001).  The privileged composition payload is NEVER delivered to a
 * caller — the lexical payload callback is null here, so no caller obtains
 * { lifecycle, composition } or bindCanonicalTransportPeer.
 */
async function createRuntimeCore(options = {}) {
    return buildRuntimeCoreInternal(sanitizeCoreOptions(options), null);
}

/**
 * createRuntimeHost(options) — ORDINARY public RuntimeHost factory.
 *
 * Sanitized: privileged continuity keys are stripped from coreOptions; a
 * caller-supplied `coreFactory` is ALWAYS treated as untrusted and receives
 * only sanitized ordinary options — NEVER a trusted sink, NEVER a
 * composition payload callback.
 */
async function createRuntimeHost(options = {}) {
    return buildRuntimeHostInternal(options, null);
}

module.exports = Object.freeze({
    createRuntimeCore,
    createRuntimeHost,
    CORE_VERSION,
    HOST_VERSION,
    LOCAL_TRANSPORT_ID,
    HOST_PHASE,
    HOST_COMMANDS,
    // Vocabulary re-exports (ordinary, non-privileged):
    governorMod,
    ib,
    presenceMod,
    // The canonical VoiceRuntime class (lexically bound above).  Exported as
    // a STABLE VALUE — no dynamic getter, no public class-builder in the
    // handoff path.  voice/voiceRuntime.js re-exports it for import compat.
    VoiceRuntime
});
