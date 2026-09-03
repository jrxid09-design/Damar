"use strict";

/**
 * DAMAR RUNTIME HOST V1 — host runtime persisten pengguna.
 *
 * Host menghidupkan createRuntimeCore() (komposisi tersertifikasi Wave 1+2)
 * dan menjadi pemilik lifecycle proses: BOOT → INITIALIZE → RECOVER →
 * READY/DORMANT → SUMMON → ACTIVE → DISMISS → SHUTDOWN, plus FAIL/RECOVER.
 *
 * HUKUM ARSITEKTURAL (load-bearing):
 *   - Runtime Host != Authority        : host tidak pernah meminting
 *     Authority; hanya membaca registry kanonik milik core.
 *   - Transport != Authentication      : asal peristiwa tidak pernah
 *     menjadi bukti kepercayaan.
 *   - Presence != Execution            : summon/dismiss hanya transisi
 *     representasi di Presence Runtime tersertifikasi.
 *   - Voice != Authority               : input suara adalah interaksi.
 *   - Summon != Permission             : summon tidak memberi izin apa pun.
 *   - Dismiss != Shutdown              : dismiss hanya DORMANT; proses tetap
 *     hidup. Shutdown hanya lewat shutdown() eksplisit.
 *   - Interaction != Actuation         : interaksi TIDAK PERNAH menggerakkan
 *     aktuator. Host tidak punya satu pun aktuator.
 *   - Recovery != current reality      : startup recovery tidak melanjutkan
 *     pekerjaan NON_RESUMABLE dan selalu masuk generasi runtime BARU.
 */

const { createRuntimeCore } = require("../../integration/runtimeCore");
const presenceMod = require("../presence");
const ib = require("../interactionBus");
const governorMod = require("../resourceGovernor");
const { HostPhaseMachine, HOST_PHASE } = require("./phases");
const { HOST_COMMANDS, normalizeHostCommand } = require("./commands");
const { createTransportAdapter } = require("./transportAdapter");

const VERSION = "1.0.0-wave3";

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

/**
 * createRuntimeHost({ coreOptions?, coreFactory?, conversationHandler?,
 *                     clock?, busBounds?, localTransportId? })
 *
 * Semua dependensi dapat disuntik untuk pengujian. Tanpa Console, tanpa
 * Electron, tanpa aktuator, tanpa transport wajib.
 */
async function createRuntimeHost({
    coreOptions = {},
    coreFactory = createRuntimeCore,
    conversationHandler = null,
    clock = defaultClock(),
    busBounds = undefined,
    localTransportId = LOCAL_TRANSPORT_ID,
    // DSC-R5-001: OPTIONAL composition-only capture hook.  This is NOT a
    // public option for ordinary host consumers — it is the private channel
    // through which the TRUSTED Voice composition captures the canonical
    // voice-continuity activation closure AT CONSTRUCTION TIME.  The
    // activation closure is invoked with (activate) ONCE here and is NEVER
    // attached to the returned host facade, host.core, or host.channels.
    // Ordinary callers omit it; an ordinary host holder can never obtain it.
    voiceActivation = null
} = {}) {
    if (typeof coreFactory !== "function") {
        throw new TypeError("HOST_CORE_FACTORY_INVALID");
    }
    if (conversationHandler !== null && typeof conversationHandler !== "function") {
        throw new TypeError("HOST_CONVERSATION_HANDLER_INVALID");
    }
    if (voiceActivation !== null && typeof voiceActivation !== "function") {
        throw new TypeError("HOST_VOICE_ACTIVATION_INVALID");
    }

    const phaseMachine = new HostPhaseMachine();

    // ------------------------------------------------------------ BOOT
    phaseMachine.transitionTo(HOST_PHASE.BOOTING, "host-boot");

    // ------------------------------------------------------- INITIALIZE
    phaseMachine.transitionTo(HOST_PHASE.INITIALIZING, "compose-runtime-core");
    // DSC-R3-004: PRIVATE closure state for the trusted continuity
    // lifecycle/linker handles.  They are delivered by the core factory
    // through the trusted sink below and NEVER attached to the returned
    // host facade or to core.
    let continuityLifecycleHandles = null;
    const continuitySink = coreFactory === createRuntimeCore
        ? (handles) => { continuityLifecycleHandles = handles; }
        : null;

    const effectiveCoreOptions = coreFactory === createRuntimeCore && conversationHandler === null
        ? { ...coreOptions, enableManagerIngress: true, trustedContinuitySink: continuitySink }
        : coreOptions;
    const core = await coreFactory(effectiveCoreOptions);
    const rt = core.presence;
    const producers = core.presenceProducers;

    // ---------------------------------------------------------- RECOVER
    // Startup recovery bersih: generasi runtime baru dicap sehingga semua
    // pekerjaan proses sebelumnya stale. Tidak ada pekerjaan yang
    // dilanjutkan — khususnya NON_RESUMABLE (mis. SPEAKING/THINKING).
    phaseMachine.transitionTo(HOST_PHASE.RECOVERING, "clean-recovery-start");
    const generationStart = core.recovery.ledger.advance("runtime-host-clean-start");
    core.recovery.tracker.recordRuntimeGeneration(generationStart.generationId);

    const recoveryPass = runPresenceRecoveryPass(rt, producers.recovery);
    if (!recoveryPass.ok) {
        phaseMachine.transitionTo(HOST_PHASE.FAILED, `recovery:${recoveryPass.code}`);
        return buildFailedHost({ phaseMachine, failureCode: recoveryPass.code });
    }

    // ---------------------------------------- CONTINUITY BOOT RESTORE (Lane 4)
    // DSC-003: during the canonical RECOVER phase, the host loads and
    // validates durable session-continuity state through the TRUSTED
    // continuity lifecycle facade (DSC-R2-005: NOT the ordinary channel
    // facade).  Restored sessions come back CLOSED (RESTORED != RESUMED).
    // Corrupt/oversized state fails CLOSED: the domain degrades to a fresh
    // continuity domain — never a partial resurrection, never a failed boot.
    const continuityLifecycle = continuityLifecycleHandles ? continuityLifecycleHandles.lifecycle : null;
    if (continuityLifecycle && typeof continuityLifecycle.restoreContinuity === "function") {
        try {
            await continuityLifecycle.restoreContinuity();
        } catch {
            // Fail-closed degradation is decided inside the domain; a hard
            // fault here must not prevent boot.
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

    /** Handler percakapan default: jujur dan inert. Menyelesaikan interaksi
     * tanpa memanggil otak lama, model, atau aktuator mana pun. */
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
    /** Summon: DORMANT → AWAKE via Presence kanonik. Tidak memberi izin,
     * tidak autentikasi siapa pun, tidak minting Authority. */
    function summon({ source = "api", reason = null } = {}) {
        if (!phaseMachine.isOperational()) {
            return { ok: false, code: "HOST_NOT_READY", phase: phaseMachine.phase };
        }
        const boundedReason = `[${String(source).slice(0, 64)}] ${reason === null ? "summon" : String(reason)}`;
        const result = rt.summon(producers.host, boundedReason.slice(0, 200));
        return { ...result, source };
    }

    /** Dismiss: menuju DORMANT via Presence kanonik. BUKAN shutdown proses,
     * tidak mencabut Authority, tidak menghancurkan kontinuitas persisten. */
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
            version: VERSION,
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
            version: VERSION,
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

    /**
     * DSC-R4-001/003 + DSC-R5-001 PRIVATE CANONICAL VOICE ACTIVATION.
     *
     * This module-private closure is the ONLY way the canonical voice
     * continuity identity (voice-runtime-owner) is activated.  It is:
     *
     *   - ZERO-ARGUMENT and VOICE-ONLY: it activates exactly one fixed
     *     runtime-owned identity; the caller supplies no channel, no peer
     *     value, no handle, and no identity string;
     *   - NEVER attached to the returned host facade, host.core, or
     *     host.channels — it is delivered ONLY to the trusted Voice
     *     composition through the construction-time `voiceActivation`
     *     capture hook;
     *   - backed by the TRUSTED COMPOSITION's OWN per-channel scope (the
     *     same private scope that mints and recognizes the handle).
     *
     * Consequently an ordinary RuntimeHost holder can NEVER activate voice
     * continuity itself, and a raw event / channel payload / model output
     * can never reach this closure.  VOICE STARTUP MAY ACTIVATE VOICE
     * CONTINUITY; ORDINARY RUNTIMEHOST HOLDER MAY NOT.
     */
    function activateCanonicalVoiceContinuity() {
        const composition = continuityLifecycleHandles ? continuityLifecycleHandles.composition : null;
        if (!composition || typeof composition.bindCanonicalTransportPeer !== "function") {
            return { ok: false, code: "TRANSPORT_PEER_SEAM_UNAVAILABLE" };
        }
        try {
            const result = composition.bindCanonicalTransportPeer("voice");
            return { ok: true, ...result };
        } catch (error) {
            return { ok: false, code: error?.code ?? "TRANSPORT_PEER_BIND_FAILED" };
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

    /** Submit langsung dari transport lokal (runtime API eksplisit).
     * sessionId kanonik dibuat otomatis bila pemanggil tidak memberikan. */
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

    /**
     * Idempoten. Mematikan aktivitas presence, adapter, lalu core.
     *
     * DSC-R2-004: SHARED SHUTDOWN COMPLETION.  The FIRST invocation creates
     * ONE canonical shutdown completion; every subsequent call JOINS that
     * same completion until it settles — no caller ever observes "shutdown
     * complete" while the final durability flush is still active.
     *
     * Synchronous callers may inspect the returned status object's
     * shutDown / idempotent / reason fields immediately (status is cleanly
     * separated from completion); awaiting the result resolves only after
     * the durable continuity flush settles (success or deterministic
     * failure — never a hang).
     */
    let shutdownCompletion = null;

    function whenShutdownSettled() {
        if (shutdownCompletion === null) return Promise.resolve(null);
        return shutdownCompletion;
    }

    function shutdown(reason = "SHUTDOWN") {
        if (shutdownCompletion !== null) {
            // DSC-R2-004: JOIN the outstanding canonical completion — do NOT
            // report an immediate "already shut down" while the flush is
            // still active.  (Once the completion has settled this is a fast
            // join of the resolved value.)
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

        // ------------------------------------ CONTINUITY SHUTDOWN FLUSH (Lane 4)
        // DSC-R1-005 + DSC-R2-002/003/004: graceful shutdown FLUSHES the
        // durable continuity snapshot through the TRUSTED lifecycle facade
        // (DSC-R2-005) and NEVER deletes persisted state.  The flush:
        //   - is fully awaited by the shared completion;
        //   - releases the durable store's same-process ownership only
        //     AFTER the final flush settles (DSC-R2-002);
        //   - resolves with a deterministic failure result on disk error —
        //     never a hang (DSC-R2-003).
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
        // Contain: the canonical completion never rejects; failure is
        // carried in the resolved result.
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

    /**
     * Wrap a synchronous status shape with the SHARED shutdown completion.
     * Awaiting the result joins the SAME canonical completion for every
     * caller; the synchronous fields remain immediately inspectable
     * (status is cleanly separated from completion).
     */
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

    /** FAIL/RECOVER: dari FAILED, presence tidak punya jalur balik legal —
     * satu-satunya pemulihan jujur adalah generasi BARU (paritas restart):
     * startNewGeneration mematikan semua aktivitas nonterminal sebagai
     * INTERRUPTED tanpa resume otomatis, lalu boot ulang sampai DORMANT. */
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
            // Recovery ringan dalam generasi yang sama.
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
        version: VERSION,

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
        // DSC-R4-003 + DSC-R5-001: the ordinary host facade exposes NO
        // continuity trust administration and NO continuity activation seam.
        // The ONLY continuity-related member retained here is the safe,
        // read-only per-transport support diagnostic.  There is deliberately
        // NO `_continuityComposition` (or any renamed equivalent) on this
        // object: HOST POSSESSION != CONTINUITY ADMINISTRATION.
        transportContinuitySupport,

        health,
        status,

        requestShutdown,
        shutdown,
        whenShutdownSettled,
        fail,
        recoverNow,

        // Referensi kanonik (read-only untuk pemeriksaan/pengujian):
        core
    });

    // DSC-R5-001: deliver the canonical voice-continuity ACTIVATION closure
    // to the TRUSTED Voice composition ONLY, through the composition-time
    // capture hook — NEVER through the returned host facade.  The closure is
    // a module-private function; it is not reachable from host, host.core,
    // host.channels, any Symbol, any resolver, or any payload.  Only the
    // composition that explicitly opted in at construction receives it.
    if (voiceActivation !== null) {
        voiceActivation(activateCanonicalVoiceContinuity);
    }

    return host;
}

/** Pass recovery Presence kanonik: DORMANT → RECOVERING → DORMANT.
 * Tidak melanjutkan aktivitas apa pun (NON_RESUMABLE tetap mati). */
function runPresenceRecoveryPass(rt, recoveryProducer) {
    try {
        const start = rt.requestRecovery(recoveryProducer, "host-startup-recovery-pass");
        if (!start.ok && start.code !== "OK_NOOP") {
            // Sudah RECOVERING / state lain yang legal tetap boleh lanjut.
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
        version: VERSION,
        get phase() { return phaseMachine.phase; },
        failed: true,
        failureCode,
        summon: () => ({ ok: false, code: "HOST_FAILED" }),
        dismiss: () => ({ ok: false, code: "HOST_FAILED" }),
        shutdown: () => Object.freeze({ shutDown: true, idempotent: false }),
        health: () => ({ phase: phaseMachine.phase, healthy: false, failureCode })
    });
}

module.exports = Object.freeze({
    createRuntimeHost,
    VERSION,
    HOST_PHASE,
    HOST_COMMANDS,
    LOCAL_TRANSPORT_ID,
    governorMod,
    ib,
    presenceMod
});
