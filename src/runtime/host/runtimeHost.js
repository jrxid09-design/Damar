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
    localTransportId = LOCAL_TRANSPORT_ID
} = {}) {
    if (typeof coreFactory !== "function") {
        throw new TypeError("HOST_CORE_FACTORY_INVALID");
    }
    if (conversationHandler !== null && typeof conversationHandler !== "function") {
        throw new TypeError("HOST_CONVERSATION_HANDLER_INVALID");
    }

    const phaseMachine = new HostPhaseMachine();

    // ------------------------------------------------------------ BOOT
    phaseMachine.transitionTo(HOST_PHASE.BOOTING, "host-boot");

    // ------------------------------------------------------- INITIALIZE
    phaseMachine.transitionTo(HOST_PHASE.INITIALIZING, "compose-runtime-core");
    const effectiveCoreOptions = coreFactory === createRuntimeCore && conversationHandler === null
        ? { ...coreOptions, enableManagerIngress: true }
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
    // validates durable session-continuity state through the trusted
    // ingress composition (core.channels).  Restored sessions come back
    // CLOSED (RESTORED != RESUMED).  Corrupt/oversized state fails CLOSED:
    // the domain degrades to a fresh continuity domain — never a partial
    // resurrection, never a failed boot.
    if (core.channels && typeof core.channels.restoreContinuity === "function") {
        try {
            await core.channels.restoreContinuity();
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
            continuity: safe(() => (core.channels && typeof core.channels.continuityStatus === "function"
                ? core.channels.continuityStatus()
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

    /** Idempoten. Mematikan aktivitas presence, adapter, lalu core.
     *
     * DSC-R1-005: the returned result is an AWAITABLE thenable —
     * `await host.shutdown(...)` resolves only after durable continuity
     * state is flushed.  Synchronous callers keep the previous contract:
     * the result object still exposes `shutDown` / `idempotent` / `reason`
     * immediately. */
    function shutdown(reason = "SHUTDOWN") {
        if (shutDown) {
            return buildShutdownResult(Object.freeze({ shutDown: true, idempotent: true, reason }), Promise.resolve({ flushed: true, idempotent: true }));
        }
        if (phaseMachine.isTerminal()) {
            shutDown = true;
            return buildShutdownResult(Object.freeze({ shutDown: true, idempotent: true, reason }), Promise.resolve({ flushed: true, idempotent: true }));
        }
        shutDown = true;
        phaseMachine.transitionTo(HOST_PHASE.SHUTTING_DOWN, reason);

        for (const adapter of adapters.values()) {
            try { adapter.disconnect(); } catch { /* tetap lanjut */ }
        }
        adapters.clear();

        // ------------------------------------ CONTINUITY SHUTDOWN FLUSH (Lane 4)
        // DSC-R1-005: graceful shutdown FLUSHES the durable continuity
        // snapshot and NEVER deletes persisted state (destructive reset is
        // a separate explicit administrative operation on the domain).  The
        // flush is fully awaited by the returned thenable; late failures
        // are contained so they can never become unhandled rejections.
        const continuityFlushPromise = (async () => {
            if (core.channels && typeof core.channels.shutdownContinuity === "function") {
                try {
                    return await core.channels.shutdownContinuity();
                } catch {
                    return Object.freeze({ failed: true, code: "FLUSH_CONTAINED" });
                }
            }
            return null;
        })();

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
            continuityFlushPromise
        );
    }

    /** Freeze a shutdown result that is BOTH synchronously inspectable and
     * awaitable (awaits durable continuity flush). */
    function buildShutdownResult(syncShape, flushPromise) {
        let promise = null;
        const result = Object.freeze({
            ...syncShape,
            get continuityFlush() { return flushPromise; },
            then(onFulfilled, onRejected) {
                if (!promise) {
                    promise = (async () => {
                        let flushed = null;
                        try {
                            flushed = await flushPromise;
                        } catch {
                            flushed = Object.freeze({ failed: true, code: "FLUSH_CONTAINED" });
                        }
                        return Object.freeze({ ...syncShape, continuityFlush: flushed });
                    })();
                }
                return promise.then(onFulfilled, onRejected);
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

        health,
        status,

        requestShutdown,
        shutdown,
        fail,
        recoverNow,

        // Referensi kanonik (read-only untuk pemeriksaan/pengujian):
        core
    });

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
