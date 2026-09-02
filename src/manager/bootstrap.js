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
 * DSC-R3-001: the trusted TRANSPORT PEER SCOPE registry.  Each supported
 * channel has a scope created HERE, inside the trusted composition, from
 * RUNTIME-OWNED semantics (see transportPeer.js for the honest support
 * matrix).  A scope mints branded TransportPeerHandle capabilities that
 * the continuity domain is the only consumer of.  Raw events can NEVER
 * mint, forge, or emulate a handle: the mint is not exported, and the
 * WeakSet brand cannot be matched by shape.
 *
 * HONEST SUPPORT MATRIX (fail-closed by default):
 *   telegram : UNSUPPORTED (claimed chatId only; no transport-authenticated
 *              sender identity wired into the canonical ingress today).
 *   whatsapp : UNSUPPORTED (claimed telemetry JID only; same gap).
 *   console  : SUPPORTED — RUNTIME_OWNER scope (the local operator surface;
 *              DEVICE/RUNTIME-SCOPED, not human-peer identity).
 *   voice    : SUPPORTED — RUNTIME_OWNER scope (the local owner audio
 *              surface; DEVICE/RUNTIME-SCOPED voice continuity, not
 *              physical-speaker identity).
 */
function createTrustedTransportPeerScopes() {
    const transportPeer = require("../runtime/sessionContinuity/transportPeer");
    const scopes = new Map();
    for (const [channel, verdict] of Object.entries(transportPeer.TRANSPORT_CONTINUITY_SUPPORT)) {
        if (verdict.supported === true) {
            scopes.set(channel, transportPeer.createTransportPeerScope({
                channel,
                supported: true,
                scope: verdict.scope,
                detail: verdict.detail
            }));
        }
    }
    return Object.freeze({
        /** Resolve the trusted peer scope for a channel (null = unsupported). */
        scope(channel) {
            return scopes.get(channel) ?? null;
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

    // Trusted transport bindings for owner-confirmed devices (composition-
    // closure state; per composition instance).
    const transportBindings = new Map();

    // DSC-R3-001: the trusted transport peer scopes (runtime-owned handle
    // mints).  Raw caller events can never mint, register, or forge these.
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

        // DSC-R2-006: the TRUSTED CONTINUITY LINK WORKFLOW, bound to the
        // canonical Device Identity & Pairing owner-confirmation flow (see
        // linkContinuityViaPairing below).  linkContinuity itself requires
        // ALREADY-MINTED TransportPeerHandles for BOTH endpoints — handles
        // only the trusted transport scopes can produce.  It links
        // continuity identity ONLY, never authority, and conflicts fail
        // closed (DSC-R3-005).
        const continuityLinker = Object.freeze({
            /**
             * Link two trusted transport endpoints (each an already-minted
             * TransportPeerHandle from a trusted transport peer scope) onto
             * the same canonical continuity identity.  Composition-owned;
             * NOT reachable from raw events, host.channels, or Manager
             * payload.
             */
            linkContinuity({ endpointA, endpointB } = {}) {
                const verifyHandle = (handle, label) => {
                    if (handle === null || typeof handle !== "object") {
                        throw Object.assign(new TypeError("CONTINUITY_LINK_ENDPOINT_INVALID"), { code: "CONTINUITY_LINK_ENDPOINT_INVALID" });
                    }
                    const scope = peerScopes.scope(handle.channel);
                    if (handle.kind !== "TransportPeerHandle" || !scope || !scope.isHandle(handle)) {
                        throw Object.assign(new Error("CONTINUITY_LINK_HANDLE_UNTRUSTED"), { code: "CONTINUITY_LINK_HANDLE_UNTRUSTED" });
                    }
                    return handle;
                };
                const handleA = verifyHandle(endpointA, "A");
                const handleB = verifyHandle(endpointB, "B");
                if (handleA.channel === handleB.channel && handleA.peer === handleB.peer) {
                    throw Object.assign(new Error("CONTINUITY_LINK_ENDPOINTS_IDENTICAL"), { code: "CONTINUITY_LINK_ENDPOINTS_IDENTICAL" });
                }
                const provenanceA = trustedContinuity.mintPeerProvenance(handleA);
                const provenanceB = trustedContinuity.mintPeerProvenance(handleB);
                return trustedContinuity.trustedLinkContinuity({ provenanceA, provenanceB });
            },
            /**
             * DSC-R2-006 REAL PRODUCTION WORKFLOW: link two trusted
             * transport endpoints through the CANONICAL Device Identity &
             * Pairing V1 owner-confirmation flow.
             *
             * The caller supplies a DeviceIdentityService whose devices are
             * ALREADY owner-confirmed (PAIRED) for both endpoints, plus the
             * pairing transaction ids that confirmed them.  The workflow:
             *
             *   Device Identity ownerConfirm (done, verified below)
             *   → pairing transactions CONFIRMED for deviceIdA / deviceIdB
             *   → each device is PAIRED (owner-confirmed trust state)
             *   → each device carries a registered transport peer binding
             *     (channel + runtime-owned peer value, recorded by trusted
             *     registration — NOT from event payload)
             *   → mint TransportPeerHandles from the trusted scopes
             *   → private continuity link (fail-closed on conflict)
             *
             * It mints NO principal, authority, capability, or permission.
             */
            linkContinuityViaPairing({ identityService, pairings } = {}) {
                const { DeviceIdentityService } = require("../embodiment/identity/service");
                if (!(identityService instanceof DeviceIdentityService)) {
                    throw Object.assign(new TypeError("CONTINUITY_LINK_IDENTITY_SERVICE_INVALID"), { code: "CONTINUITY_LINK_IDENTITY_SERVICE_INVALID" });
                }
                if (pairings === null || typeof pairings !== "object" || Array.isArray(pairings)) {
                    throw Object.assign(new TypeError("CONTINUITY_LINK_PAIRINGS_INVALID"), { code: "CONTINUITY_LINK_PAIRINGS_INVALID" });
                }
                const resolveEndpoint = (pairingId, label) => {
                    if (typeof pairingId !== "string" || pairingId.length === 0) {
                        throw Object.assign(new Error("CONTINUITY_LINK_PAIRING_INVALID"), { code: "CONTINUITY_LINK_PAIRING_INVALID" });
                    }
                    // Serialize() exposes CONFIRMED transactions: the canonical
                    // proof that ownerConfirm happened for this pairing.
                    const confirmed = identityService.serialize().transactions.find(
                        (t) => t.pairingId === pairingId && t.state === "CONFIRMED"
                    );
                    if (!confirmed) {
                        throw Object.assign(new Error("CONTINUITY_LINK_PAIRING_UNCONFIRMED"), { code: "CONTINUITY_LINK_PAIRING_UNCONFIRMED" });
                    }
                    const identity = identityService.getIdentity(confirmed.deviceId);
                    if (!identity || identity.pairingState !== "PAIRED") {
                        throw Object.assign(new Error("CONTINUITY_LINK_DEVICE_UNPAIRED"), { code: "CONTINUITY_LINK_DEVICE_UNPAIRED" });
                    }
                    // The trusted registration of the transport binding for this
                    // owner-confirmed device.  Registration is an explicit
                    // trusted act (see registerTransportBinding); event payload
                    // is never consulted.
                    const binding = transportBindings.get(confirmed.deviceId);
                    if (!binding) {
                        throw Object.assign(new Error("CONTINUITY_LINK_TRANSPORT_BINDING_MISSING"), { code: "CONTINUITY_LINK_TRANSPORT_BINDING_MISSING" });
                    }
                    const scope = peerScopes.scope(binding.channel);
                    if (!scope) {
                        throw Object.assign(new Error("CONTINUITY_LINK_CHANNEL_UNTRUSTED"), { code: "CONTINUITY_LINK_CHANNEL_UNTRUSTED" });
                    }
                    // Mint the runtime-owned handle from the REGISTERED peer
                    // value (trusted registration, not event text).
                    return scope.mint(binding.peer);
                };
                const handleA = resolveEndpoint(pairings.endpointA, "A");
                const handleB = resolveEndpoint(pairings.endpointB, "B");
                if (handleA.channel === handleB.channel && handleA.peer === handleB.peer) {
                    throw Object.assign(new Error("CONTINUITY_LINK_ENDPOINTS_IDENTICAL"), { code: "CONTINUITY_LINK_ENDPOINTS_IDENTICAL" });
                }
                const provenanceA = trustedContinuity.mintPeerProvenance(handleA);
                const provenanceB = trustedContinuity.mintPeerProvenance(handleB);
                return trustedContinuity.trustedLinkContinuity({ provenanceA, provenanceB });
            },
            /**
             * TRUSTED registration of a transport peer binding for an
             * owner-confirmed device.  This is the explicit act that
             * connects a PAIRED device to its runtime-owned transport
             * identity value (e.g. the voice runtime owner scope value, the
             * console owner scope value).  The peer value must come from
             * trusted runtime state, never from event payload.
             */
            registerTransportBinding({ identityService, deviceId, channel, peer } = {}) {
                const { DeviceIdentityService } = require("../embodiment/identity/service");
                if (!(identityService instanceof DeviceIdentityService)) {
                    throw Object.assign(new TypeError("CONTINUITY_LINK_IDENTITY_SERVICE_INVALID"), { code: "CONTINUITY_LINK_IDENTITY_SERVICE_INVALID" });
                }
                if (typeof deviceId !== "string" || deviceId.length === 0) {
                    throw Object.assign(new Error("CONTINUITY_LINK_DEVICE_INVALID"), { code: "CONTINUITY_LINK_DEVICE_INVALID" });
                }
                const scope = peerScopes.scope(channel);
                if (!scope) {
                    throw Object.assign(new Error("CONTINUITY_LINK_CHANNEL_UNTRUSTED"), { code: "CONTINUITY_LINK_CHANNEL_UNTRUSTED" });
                }
                // Validate the peer value through the scope mint (bounds,
                // charset) WITHOUT retaining the handle.
                scope.mint(peer);
                const identity = identityService.getIdentity(deviceId);
                if (!identity || identity.pairingState !== "PAIRED") {
                    throw Object.assign(new Error("CONTINUITY_LINK_DEVICE_UNPAIRED"), { code: "CONTINUITY_LINK_DEVICE_UNPAIRED" });
                }
                transportBindings.set(deviceId, Object.freeze({ channel, peer }));
                return Object.freeze({ deviceId, channel, registered: true });
            }
        });

        constructionComplete = true;
        return Object.freeze({
            ...ingress,
            continuityLinker
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
