"use strict";

/**
 * DAMAR MANAGER — request/result schema + bounds vocabulary (Lane 5, inert
 * schemas ONLY — no formers, no brands, no composition).
 *
 * CANONICAL MANAGER REQUEST SCHEMA (informational, for consumers):
 *
 *   {
 *     schemaVersion: 1,
 *     requestId,            // uuid minted by the trusted former
 *     principal,            // canonical authenticated subject (bound AFTER
 *                           // canonical authentication — never caller-supplied)
 *     sessionProvenance,    // { channelType, sessionId, channelPeer }
 *     channelId,
 *     channelType,          // console | cli | telegram | whatsapp | companion
 *     correlationId,        // conversation/session correlation
 *     receivedAtMs,
 *     payload,              // bounded detached declarative request payload
 *     intentMaterial,       // optional declarative proposal (PLAN != AUTHORITY)
 *     cancellationId        // lifecycle/cancellation token identity
 *   }
 *
 * Caller-provided fields are NEVER authority merely because they are present
 * in request metadata: principal and session identity are bound by the
 * canonical authentication path (fail-closed), not by payload fields.
 *
 * CANONICAL MANAGER RESULT SCHEMA (informational):
 *
 *   {
 *     schemaVersion: 1,
 *     managerRequestId,
 *     actionIntentId,       // if an action intent was formed
 *     authorityEvidence:    // reference to the decision evidence (historical)
 *       { decision, reasonCode, evaluatedAtMs } | null,
 *     executionId,          // if dispatched
 *     verificationId,       // if verified
 *     compensationId,       // if compensation attempted
 *     lifecycleState,       // LIFECYCLE
 *     outcome,              // OUTCOME (uniform across channels)
 *     detail,               // sanitized human-readable summary
 *     evidenceSummary,      // sanitized bounded evidence
 *     errorReason,          // typed Manager reason if applicable
 *     startedAtMs, completedAtMs
 *   }
 *
 * MANAGER RESULT != AUTHORITY. A ManagerResult is historical/result
 * evidence: it must never be usable as a bearer authorization object.
 */

const REQUEST_SCHEMA_VERSION = 1;
const RESULT_SCHEMA_VERSION = 1;

/** Supported active channel classes (ONE Damar identity across all of them). */
const CHANNEL_TYPES = Object.freeze({
    CONSOLE: "console",
    CLI: "cli",
    TELEGRAM: "telegram",
    WHATSAPP: "whatsapp",
    COMPANION: "companion"
});

const BOUNDS = Object.freeze({
    MAX_REQUEST_ID_CHARS: 128,
    MAX_PRINCIPAL_CHARS: 128,
    MAX_CHANNEL_ID_CHARS: 128,
    MAX_CORRELATION_CHARS: 128,
    MAX_CANCELLATION_ID_CHARS: 128,
    MAX_PAYLOAD_NODES: 512,
    MAX_PAYLOAD_KEY_CHARS: 128,
    MAX_PAYLOAD_STRING_CHARS: 1024,
    MAX_PAYLOAD_KEYS: 64,
    MAX_INTENT_MATERIAL_NODES: 512,
    MAX_DETAIL_CHARS: 1024,
    GLOBAL_MAX_ARRAY_LENGTH: 1024,
    MAX_ACTIVE_REQUESTS: 4096
});

/** PURE predicate — is `channelType` a supported channel class? */
function isChannelType(channelType) {
    return typeof channelType === "string" &&
        Object.values(CHANNEL_TYPES).includes(channelType);
}

module.exports = {
    // inert frozen vocabulary + pure predicate ONLY
    REQUEST_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    CHANNEL_TYPES,
    BOUNDS,
    isChannelType
};

// NOT exported: any request/result former, any brand state.
