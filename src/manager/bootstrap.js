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
 * DSC-R4-001: the trusted TRANSPORT PEER SCOPE registry is created HERE,
 * inside the trusted composition, one PER-RUNTIME scope per SUPPORTED
 * channel.  Each scope is minted by the PRIVATE `mintCanonicalTransportPeerHandle`
 * seam (transportPeer.js) and recognizes ONLY the handle it minted itself —
 * per-scope provenance, never a global brand.
 *
 * The registry exposes `bind(channel, handle)` (verify per-scope provenance,
 * then hand the handle to the ingress's runtime-owned active-peer map) and
 * `support(channel)` (honest verdict).  It exposes NO mint and NO scope
 * object to any caller, so an ordinary module can never fabricate a handle
 * the canonical composition will accept.
 *
 * HONEST SUPPORT MATRIX (fail-closed by default):
 *   telegram : UNSUPPORTED (claimed chatId only; no transport-authenticated
 *              sender identity wired into the canonical ingress today).
 *   whatsapp : UNSUPPORTED (claimed telemetry JID only; same gap).
 *   console  : UNSUPPORTED (DSC-R4-005 — no canonical production startup
 *              path binds a runtime-owned console identity automatically).
 *   voice    : SUPPORTED — RUNTIME_OWNER scope; the canonical VoiceRuntime
 *              binds its runtime-owner peer through the private RuntimeHost
 *              transport binder at start (DEVICE/RUNTIME-SCOPED, not
 *              physical-speaker identity).
 */
function createTrustedTransportPeerScopes() {
    // DSC-R5-003: the canonical trust mint is imported from the INTERNAL
    // composition entry point (NOT the public transportPeer surface, which
    // exposes only read-only verdicts).  This is the SOLE production caller.
    const { mintCanonicalTransportPeerHandle } = require("../runtime/sessionContinuity/transportPeerInternal");
    const transportPeer = require("../runtime/sessionContinuity/transportPeer");
    // channel -> { scope, handle } minted ONCE by the private canonical mint.
    // The SAME scope object both mints and recognizes the handle, so
    // provenance is per-scope and self-consistent within this composition.
    const canonical = new Map();
    const ensure = (channel) => {
        if (!canonical.has(channel)) {
            const verdict = transportPeer.transportContinuitySupport(channel);
            if (!verdict || verdict.supported !== true) return null;
            canonical.set(channel, mintCanonicalTransportPeerHandle(channel));
        }
        return canonical.get(channel);
    };
    return Object.freeze({
        /**
         * TRUSTED-ONLY, NO-ARGUMENT canonical bind: mint + return the
         * runtime-owner handle for a SUPPORTED channel through this
         * composition's OWN per-channel scope.  The RuntimeHost private
         * canonical binder calls this with a channel name ONLY — never a
         * handle, never a peer value.  Because the handle is minted and
         * recognized by the SAME private scope, foreign/test-scope handles
         * can never be substituted, and an ordinary caller can never select
         * the peer identity.  UNSUPPORTED channels throw (fail closed).
         */
        mintCanonical(channel) {
            const entry = ensure(channel);
            if (!entry) {
                throw Object.assign(new Error("TRANSPORT_PEER_UNSUPPORTED"), { code: "TRANSPORT_PEER_UNSUPPORTED" });
            }
            return entry.handle;
        },
        /** Honest verdict lookup (also exposed to the ingress seam). */
        support(channel) {
            return transportPeer.transportContinuitySupport(channel);
        }
    });
}

function createDamarManagerIngressDomain({ bus, mediaSubsystem = null, sessionContinuity = null, continuityStoreFile = undefined, transportPeerScopes = undefined } = {}) {
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
            // Explicit inert mode (DAMAR_CONTINUITY_STATE=memory).
            continuity = sessionContinuityMod.createSessionContinuity({
                idFactory: sessionContinuityMod.createCryptoContinuityIdFactory(),
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
                trustedLifecycle(controller) {
                    trustedContinuity = Object.freeze({
                        mintPeerProvenance: controller.mintPeerProvenance,
                        trustedLinkContinuity: controller.trustedLinkContinuity
                    });
                }
            });
        }
    }

    // DSC-R4-001: the trusted transport peer scopes (per-runtime, per-scope
    // runtime-owned handle mints).  Raw caller events can never mint,
    // register, or forge these; the mint is private to this composition.
    const peerScopes = transportPeerScopes !== undefined && transportPeerScopes !== null
        ? transportPeerScopes
        : createTrustedTransportPeerScopes();

    // DSC-R3-003: CONSTRUCTION-FAILURE OWNERSHIP ROLLBACK.  The store
    // ownership was acquired above; if ANY later construction step throws,
    // release it before rethrowing so the durable path is never leaked.
    let constructionComplete = false;
    try {
        const ingress = require("../runtime/interactionBus/managerIngressInternal").createManagerInteractionIngress({
            bus,
            manager,
            mediaSubsystem,
            mediaContextMint: canonicalMediaContextAuthority.mint,
            sessionContinuity: continuity,
            trustedContinuity,
            peerScopes,
            continuityStoreHandle
        });

        // DSC-R4-002/004 — HONEST CONTINUITY ADMIN SURFACE (fail-closed).
        //
        // Cross-channel owner-confirmed LINKING is UNSUPPORTED in the current
        // production runtime.  Repository inspection proved there is NO
        // genuine production owner-confirmation trust root: the canonical
        // action-runtime authentication adapter is a deliberate fail-closed
        // stub that authenticates NOBODY, and DeviceIdentityService.ownerConfirm
        // / AuthorityRegistry.ratify are only ever invoked from tests.  A
        // CALLER-SUPPLIED DeviceIdentityService is therefore NOT a real owner
        // trust root (any caller can construct one and self-confirm a fake
        // pairing).  Per the repair mandate, we DO NOT fabricate an owner
        // root just to pass tests.
        //
        // The private continuity link core (trustedLinkContinuity /
        // trustedTransferBinding) is PRESERVED inside the continuity domain
        // for a future lane that wires a canonical owner/admin trust root —
        // but it is NOT reachable from the RuntimeHost facade, host.channels,
        // the Manager payload, raw events, or any caller-supplied identity
        // service.  This surface reports the missing prerequisite honestly.
        const continuityAdmin = Object.freeze({
            /**
             * Honest capability verdict: cross-channel owner-confirmed
             * linking is NOT supported by any production surface today.
             */
            linkingSupport() {
                return Object.freeze({
                    supported: false,
                    code: "CONTINUITY_LINK_UNSUPPORTED",
                    reason: "OWNER_TRUST_ROOT_UNAVAILABLE",
                    detail: "no canonical production owner-confirmation trust root exists; caller-supplied DeviceIdentityService is not accepted as proof; linking fails closed"
                });
            }
        });

        constructionComplete = true;
        return Object.freeze({
            ...ingress,
            continuityAdmin
        });
    } catch (error) {
        // DSC-R3-003: release the acquired durable-store ownership so a
        // failed composition never leaks the path.  No active writer exists
        // during construction, so the release is safe.
        if (!constructionComplete && continuityStoreHandle !== null && typeof continuityStoreHandle.finalizeShutdown === "function") {
            try { continuityStoreHandle.finalizeShutdown(); } catch { /* best-effort rollback */ }
        }
        throw error;
    }
}

module.exports = { createDamarManager, createDamarManagerIngressDomain };
