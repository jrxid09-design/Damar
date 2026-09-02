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

function createDamarManagerIngressDomain({ bus, mediaSubsystem = null, sessionContinuity = null, continuityStoreFile = undefined } = {}) {
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
                        mintPeerProvenance: controller.mintPeerProvenance
                    });
                }
            });
        } else {
            // Production default: durable file store (same-process ownership
            // enforced), persisted through a bounded coalescing scheduler.
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
                        mintPeerProvenance: controller.mintPeerProvenance
                    });
                }
            });
        }
    }
    // DSC-R1-006: RUNTIME-OWNED peer evidence provider.  This is the trusted
    // composition's per-channel transport identity extraction.  For the
    // canonical ingress channels, the runtime-owned evidence field is
    // `trustedPeerEvidence` — set ONLY by trusted transport adapters that
    // themselves derived the identity from the transport layer (authenticated
    // Telegram sender/chat id, WhatsApp JID from the transport, runtime-owned
    // console/voice identity).  The raw caller `userId` field is deliberately
    // NOT consulted: caller-supplied text can never establish continuity
    // identity.
    const peerEvidenceProvider = (channel, rawEvent) => {
        if (rawEvent === null || typeof rawEvent !== "object") return "";
        const descriptor = Object.getOwnPropertyDescriptor(rawEvent, "trustedPeerEvidence");
        if (!descriptor || !("value" in descriptor)) return "";
        const evidence = descriptor.value;
        if (typeof evidence !== "string") return "";
        return evidence;
    };
    return require("../runtime/interactionBus/managerIngressInternal").createManagerInteractionIngress({
        bus,
        manager,
        mediaSubsystem,
        mediaContextMint: canonicalMediaContextAuthority.mint,
        sessionContinuity: continuity,
        trustedContinuity,
        peerEvidenceProvider,
        continuityStoreHandle
    });
}

module.exports = { createDamarManager, createDamarManagerIngressDomain };
