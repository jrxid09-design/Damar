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
 * CANONICAL VoiceRuntime BINDING (lexical; public product facade)
 * ========================================================================= */

// The bound VoiceRuntime class, built ONCE lazily from voiceRuntime.js's
// ORDINARY buildVoiceRuntimeClass with the LEXICAL canonical composition
// functions.  The lexical functions NEVER leave this module — only the
// already-bound class is exposed (legitimate product facade; R8 mandate #3).
let _voiceRuntimeClass = null;
function getBoundVoiceRuntime() {
    if (_voiceRuntimeClass === null) {
        const { buildVoiceRuntimeClass } = require("../voice/voiceRuntime");
        _voiceRuntimeClass = buildVoiceRuntimeClass({
            composeHost: (coreOptions) => composeCanonicalVoiceHost(coreOptions),
            activateVoice: (host) => activateVoiceContinuity(host)
        });
    }
    return _voiceRuntimeClass;
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
    // The already-bound canonical VoiceRuntime (legitimate public product
    // facade).  The lexical composition/activation functions that built it
    // NEVER leave this module.  Lazy so voiceRuntime.js's re-export does not
    // create a require cycle at module load.
    get VoiceRuntime() {
        return getBoundVoiceRuntime();
    }
});
