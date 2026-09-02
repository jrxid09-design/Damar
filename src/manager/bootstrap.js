"use strict";

/**
 * DAMAR MANAGER — CANONICAL TRUSTED BOOTSTRAP (Lane 5).
 *
 * This is the ONLY place where the canonical application Manager instance is
 * created. It is NOT a public/downstream API surface beyond the frozen facade
 * it returns.
 *
 * CORE LAWS:
 *
 *   MANAGER != AUTHORITY
 *   FACTORY AVAILABLE != CANONICAL APPLICATION MANAGER INSTANCE
 *   FIRST COMPOSITION CREATION DOES NOT ESTABLISH SHARED TRUST
 *
 * The production canonical Manager is created by createDamarManager() which
 * takes NO options: the Lane 2/Lane 3/Lane 4 facades are the canonical
 * bootstrap-owned singletons, and NO test channel adapters are wired. The
 * canonical authentication path is fail-closed (the Lane 2 bootstrap's fixed
 * adapter) until a later lane wires real trusted auth infrastructure INTO the
 * bootstrap — the Manager can therefore never mint a principal that trusted
 * infrastructure did not establish.
 *
 * The production facade is EXACTLY:
 *
 *     Object.freeze({ handle, cancel,
 *                     isCanonicalManagerRequest, isCanonicalManagerResult })
 *
 * It MUST NOT and DOES NOT expose: the Lane 2/Lane 3/Lane 4 facades, the
 * planner, the verifier/actuator registries, the capability registrar, any
 * brand state, any composition factory, or any channel authority hook.
 */

const { createDamarManagerComposition } = require("./internal/managerBootstrap");
const { CHANNEL_ADAPTERS } = require("./channels");
const { createCanonicalActionFacade, createCanonicalActuationFacade, createCanonicalVerificationFacade } = require("../action/bootstrap");
const { fail, REASONS } = require("../action/errors");

// The ONE canonical application Manager, created exactly once, lazily.
let canonicalManager = null;
let canonicalMediaContextAuthority = null;

/**
 * Create the canonical application Damar Manager facade. Takes NO options.
 *
 * @returns {object} frozen least-privilege facade, EXACTLY:
 *     { handle, cancel, isCanonicalManagerRequest, isCanonicalManagerResult }
 */
function createDamarManager() {
    if (arguments[0] !== undefined) {
        throw fail(REASONS.CALLER_BOOTSTRAP_REJECTED,
            "canonical manager creation accepts NO options; the Lane 2/3/4 facades, planner, and channel adapters are bootstrap-owned");
    }
    if (canonicalManager === null) {
        const { createMediaContextAuthority } = require("./internal/mediaContext");
        const { createRealtimeMultimodalProcessor } = require("../runtime/realtimeMultimodal");
        canonicalMediaContextAuthority = createMediaContextAuthority();
        canonicalManager = createDamarManagerComposition({
            deps: {
                // Canonical certified fabric singletons (bootstrap-owned).
                lane2: createCanonicalActionFacade(),
                lane3: createCanonicalActuationFacade(),
                lane4: createCanonicalVerificationFacade(),
                // No production planner is wired in Lane 5 V1; cognition
                // integration is advisory and defaults to null (non-action
                // requests complete without it).
                planner: null
            },
            // Trusted built-in normalizers only; no caller-controlled registry
            // or adapter injection is exposed by this bootstrap.
            trustedChannelAdapters: CHANNEL_ADAPTERS.slice(),
            mediaProcessor: createRealtimeMultimodalProcessor(),
            mediaContextAuthority: canonicalMediaContextAuthority
        });
    }
    return canonicalManager;
}

/** Trusted runtime composition: pair one Bus/MediaIngress ownership domain
 * with one Manager media-context brand and expose only channel ingestion.
 * No context mint, processor registry, or Manager dependency escapes.
 *
 * Wave 5 Lane 4 (repair R1, DSC-003): the composition root owns the durable
 * session-continuity domain for this ingress composition.  The durable
 * snapshot location defaults to the canonical per-user runtime state
 * directory (os.homedir()/.damar/continuity-v1.json) and is overridable via
 * DAMAR_CONTINUITY_STATE (absolute path) or explicitly disabled with
 * DAMAR_CONTINUITY_STATE=memory.  The domain persists on every durable
 * mutation (no timer loops) and flushes on shutdown WITHOUT deleting the
 * persisted snapshot.  The continuity domain is inert identity machinery —
 * it mints no authority and never reaches the Manager facade. */
function resolveProductionContinuityStore() {
    const setting = process.env.DAMAR_CONTINUITY_STATE;
    if (setting === "memory") return null;
    if (typeof setting === "string" && setting.length > 0) {
        return require("node:path").resolve(setting);
    }
    const os = require("node:os");
    const path = require("node:path");
    return path.join(os.homedir(), ".damar", "continuity-v1.json");
}

/**
 * DSC-R2-001 — TRANSPORT IDENTITY REGISTRY (trusted composition-owned).
 *
 * The trusted composition registers, AT COMPOSITION TIME, the
 * TRANSPORT-OWNED canonical peer identity derivation for each supported
 * channel.  Entries are closure-branded: no caller can forge one, and the
 * raw event object is NEVER consulted for trust evidence — the registered
 * extractor may only correlate the event to identity the runtime itself
 * established (e.g. the transport-scoped bus session ses_* the
 * InteractionBus minted for this channel).
 *
 * Trust boundary:
 *   transport-specific adapter (registered extractor)
 *   → runtime-owned canonical peer identity
 *   → private continuity provenance mint
 *   → Manager ingress
 *
 * Channels WITHOUT a registered extractor fail closed for continuity (no
 * binding); the ordinary ses_* interaction path continues unchanged.
 */
function createTransportIdentityRegistry() {
    const REGISTERED = new WeakMap(); // extractor fn → branded
    const extractors = new Map();     // channel name → extractor fn
    return Object.freeze({
        /** Register the transport-owned identity extractor for a channel.
         * TRUSTED COMPOSITION ONLY. */
        register(channel, extractor) {
            if (typeof channel !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(channel)) {
                throw new TypeError("TRANSPORT_IDENTITY_CHANNEL_INVALID");
            }
            if (typeof extractor !== "function") {
                throw new TypeError("TRANSPORT_IDENTITY_EXTRACTOR_INVALID");
            }
            extractors.set(channel, extractor);
            REGISTERED.set(extractor, true);
            return Object.freeze({ channel, registered: true });
        },
        /** Resolve the transport-owned identity for an event.  Returns ""
         * (fail closed) when the channel has no registered extractor or the
         * extractor yields no trustworthy identity. */
        resolve(channel, rawEvent) {
            const extractor = extractors.get(channel);
            if (!extractor || REGISTERED.get(extractor) !== true) return "";
            try {
                const identity = extractor(rawEvent);
                return typeof identity === "string" ? identity : "";
            } catch {
                return "";
            }
        },
        has(channel) {
            return extractors.has(channel);
        }
    });
}

/**
 * DSC-R2-001 — canonical transport-owned identity extractors.
 *
 * Each extractor derives identity ONLY from runtime-established state:
 * the transport-scoped bus session (ses_*) that the InteractionBus itself
 * minted for this channel.  The raw event's payload fields are never read
 * for trust purposes — the event's sessionId, when the RUNTIME minted it,
 * is the runtime-owned handle for this channel's peer stream.  Transports
 * that authenticate at the transport layer (Telegram API sender id,
 * WhatsApp JID from the socket, paired device identity) register richer
 * extractors through this same trusted seam as those transports are wired.
 */
function defaultTransportIdentityExtractors() {
    const extractorFor = (rawEvent) => {
        const sessionId = Object.getOwnPropertyDescriptor(rawEvent ?? {}, "sessionId");
        if (!sessionId || typeof sessionId.value !== "string") return "";
        return sessionId.value.startsWith("ses_") ? sessionId.value : "";
    };
    return {
        telegram: extractorFor,
        whatsapp: extractorFor,
        console: extractorFor,
        voice: extractorFor
    };
}

function createDamarManagerIngressDomain({ bus, mediaSubsystem = null, sessionContinuity = null, continuityStoreFile = undefined, transportIdentityRegistry = undefined } = {}) {
    const manager = createDamarManager();
    let continuity = sessionContinuity !== null && sessionContinuity !== undefined
        ? sessionContinuity
        : null;
    let trustedContinuity = null;
    let continuityStoreHandle = null;
    if (continuity === null) {
        const sessionContinuityMod = require("../runtime/sessionContinuity");
        const storeFile = continuityStoreFile !== undefined
            ? continuityStoreFile
            : resolveProductionContinuityStore();
        if (storeFile === null) {
            // Explicit inert mode (DAMAR_CONTINUITY_STATE=memory): continuity
            // identity is still resolved, but nothing is durable.
            continuity = sessionContinuityMod.createSessionContinuity({
                idFactory: sessionContinuityMod.createCryptoContinuityIdFactory(),
                // DSC-R1-001: the trusted controller is captured HERE, inside
                // the trusted composition closure, and never escapes.
                trustedLifecycle(controller) {
                    trustedContinuity = Object.freeze({
                        mintPeerProvenance: controller.mintPeerProvenance,
                        trustedLinkContinuity: controller.trustedLinkContinuity
                    });
                }
            });
        } else {
            // Production default: durable file store (same-process ownership
            // enforced until the final flush settles), persisted through a
            // bounded coalescing epoch scheduler.
            const store = sessionContinuityMod.createFileContinuityStore(storeFile);
            continuityStoreHandle = store;
            continuity = sessionContinuityMod.createSessionContinuity({
                idFactory: sessionContinuityMod.createCryptoContinuityIdFactory(),
                store,
                persistOnMutation: true,
                // DSC-R1-001: the trusted controller is captured HERE, inside
                // the trusted composition closure, and never escapes.
                trustedLifecycle(controller) {
                    trustedContinuity = Object.freeze({
                        mintPeerProvenance: controller.mintPeerProvenance,
                        trustedLinkContinuity: controller.trustedLinkContinuity
                    });
                }
            });
        }
    }

    // DSC-R2-001: the transport identity registry.  The trusted composition
    // (or a trusted caller supplying transportIdentityRegistry) registers
    // TRANSPORT-OWNED extractors.  Raw caller events can NEVER register or
    // forge entries.
    const transportIdentity = transportIdentityRegistry !== undefined && transportIdentityRegistry !== null
        ? transportIdentityRegistry
        : (() => {
            const registry = createTransportIdentityRegistry();
            for (const [channel, extractor] of Object.entries(defaultTransportIdentityExtractors())) {
                registry.register(channel, extractor);
            }
            return registry;
        })();

    const ingress = require("../runtime/interactionBus/managerIngressInternal").createManagerInteractionIngress({
        bus,
        manager,
        mediaSubsystem,
        mediaContextMint: canonicalMediaContextAuthority.mint,
        sessionContinuity: continuity,
        trustedContinuity,
        transportIdentity,
        continuityStoreHandle
    });

    // DSC-R2-006: the TRUSTED CONTINUITY LINKER — a narrow, explicit,
    // composition-owned operation.  It is NOT reachable from raw channel
    // events, the ordinary host.channels facade, Manager payload, or the
    // public continuity facade.  It requires TRUSTED transport identity for
    // BOTH endpoints, and it links CONTINUITY IDENTITY ONLY — never
    // authority.  No automatic matching by username/phone/userId text ever
    // occurs: every link is explicit.
    const continuityLinker = Object.freeze({
        /**
         * Explicitly link two trusted transport endpoints onto the same
         * canonical continuity identity.
         *
         * @param {object} endpointA { channel, identity } — TRUSTED identity
         *        for endpoint A (runtime-owned transport identity).
         * @param {object} endpointB { channel, identity } — same contract.
         */
        linkContinuity({ endpointA, endpointB } = {}) {
            const verifyEndpoint = (endpoint) => {
                if (endpoint === null || typeof endpoint !== "object") {
                    throw Object.assign(new TypeError("CONTINUITY_LINK_ENDPOINT_INVALID"), { code: "CONTINUITY_LINK_ENDPOINT_INVALID" });
                }
                const channel = endpoint.channel;
                const identity = endpoint.identity;
                if (typeof channel !== "string" || !transportIdentity.has(channel)) {
                    throw Object.assign(new Error("CONTINUITY_LINK_CHANNEL_UNTRUSTED"), { code: "CONTINUITY_LINK_CHANNEL_UNTRUSTED" });
                }
                if (typeof identity !== "string" || identity.length === 0) {
                    throw Object.assign(new Error("CONTINUITY_LINK_IDENTITY_UNTRUSTED"), { code: "CONTINUITY_LINK_IDENTITY_UNTRUSTED" });
                }
                return { channel, identity };
            };
            const a = verifyEndpoint(endpointA);
            const b = verifyEndpoint(endpointB);
            if (a.channel === b.channel && a.identity === b.identity) {
                throw Object.assign(new Error("CONTINUITY_LINK_ENDPOINTS_IDENTICAL"), { code: "CONTINUITY_LINK_ENDPOINTS_IDENTICAL" });
            }
            const provenanceA = trustedContinuity.mintPeerProvenance(a.channel, a.identity);
            const provenanceB = trustedContinuity.mintPeerProvenance(b.channel, b.identity);
            return trustedContinuity.trustedLinkContinuity({ provenanceA, provenanceB });
        }
    });

    return Object.freeze({
        ...ingress,
        // DSC-R2-006: trusted composition-only linking workflow.
        continuityLinker
    });
}

module.exports = { createDamarManager, createDamarManagerIngressDomain };
