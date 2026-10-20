"use strict";

/**
 * W5-CLI T2 — CANONICAL CONNECTED CLI SESSION INGRESS (Phase C/D/E).
 *
 * This module is INGRESS, NEVER AUTHORITY.  It is the CLI-facing entry point
 * that (a) runs the CERTIFIED bounded CLI session ceremony and (b) submits a
 * governed action request into the ONE canonical Damar Manager.  It adds no
 * third trust root: it composes the two certified ones.
 *
 *   manager    — the canonical Manager facade (src/manager/bootstrap.js).
 *                Every consequential submit goes through manager.handle();
 *                the existing Authority Gate and Lane 3 are untouched.
 *   ownerTrust — the sealed OwnerTrust composition (ownerTrustComposition):
 *                the CLI session authority, the sealed one-use proof verifier
 *                and (when wired, Phase B) the canonical durable IdentityStore.
 *
 * INVARIANTS
 *   - No bearer-only trust.  A connection handle NEVER authenticates an
 *     action: every `submit` must carry a FRESH one-use Owner proof that the
 *     Manager's own bootstrap-owned verifier checks.  The session only scopes
 *     WHICH device/surface may attempt it.
 *   - No caller-supplied identity/owner claim becomes authority.  The ACTIVE
 *     Owner is read from the canonical registry; the device from COMMITTED
 *     identity state.  Caller fields are opaque, bounded strings only.
 *   - Session authority stays Manager/composition-owned.  The branded session
 *     object lives in this closure keyed by an opaque connectionId and is
 *     NEVER returned or serialized; a restart loses every connection.
 *   - A VALID SESSION IS NOT ACTION APPROVAL.  `submit` revalidates the
 *     session against live canonical device trust and then hands the request
 *     to the Manager, whose Gate independently authorizes it.  Revalidation
 *     is NOT atomic with execution: a device revocation committed mid-flight
 *     can still let an already-dispatched effect finish exactly once (the
 *     Manager never silently retries); every later submit fails closed.
 *
 * OPERATIONS (one `request(envelope)` entry; every field validated)
 *   status            — readiness + session-contract wiring (no auth)
 *   authBegin         — canonical one-use challenge bound to device+surface
 *   authComplete      — Owner proof + device proof => bounded session
 *   session           — inspect the live session (live revalidation)
 *   actionChallenge   — fresh one-use `owner-proof` challenge for an action
 *   capabilities      — canonical capability discovery (session-scoped)
 *   submit            — governed action through manager.handle()
 *   logout            — revoke + drop the connection
 */

const crypto = require("node:crypto");

const CLI_CHANNEL_TYPE = "cli";
const MAX_TOKEN = 200;
const MAX_CONNECTIONS = 512;

const OPS = Object.freeze([
    "status", "authBegin", "authComplete", "session",
    "actionChallenge", "capabilities", "submit", "logout"
]);

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

function deny(code, detail = "") {
    return Object.freeze({ ok: false, code, detail: String(detail).slice(0, 256) });
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function bounded(value, field, { max = MAX_TOKEN, required = true } = {}) {
    if (value === undefined || value === null) {
        if (required) throw fail("OT_INGRESS_INVALID", `${field} required`);
        return null;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw fail("OT_INGRESS_INVALID", `${field} must be a bounded non-empty string`);
    }
    return value;
}

/**
 * createCliSessionBridge({ manager, ownerTrust, channelId })
 *
 * @param manager    canonical Manager facade ({ handle, cancel, ... }).
 * @param ownerTrust canonical branded OwnerTrust composition.
 * @param channelId  bounded CLI channel identifier recorded as INERT
 *                   provenance on every Manager request.
 */
function createCliSessionBridge({ manager, ownerTrust, channelId = "cli-surface" } = {}) {
    if (!manager || typeof manager.handle !== "function") {
        throw fail("OT_INGRESS_INVALID", "a canonical Manager facade is required");
    }
    const isCanonical = require("../authority/ownerTrustComposition").isCanonicalOwnerTrustComposition;
    if (!isCanonical(ownerTrust)) {
        throw fail("OT_INGRESS_INVALID", "a branded canonical OwnerTrust composition is required");
    }
    const safeChannelId = bounded(channelId, "channelId");

    const cliSession = ownerTrust.cliSession;
    if (!cliSession || typeof cliSession.issueSession !== "function") {
        throw fail("OT_INGRESS_INVALID", "the composition exposes no CLI session authority");
    }

    // Opaque, process-local connection handles.  The branded session object is
    // the value; it is never returned to a caller.
    const connections = new Map();

    async function verifyConnection(record) {
        return cliSession.verifySession(record.session, {
            deviceId: record.deviceId,
            surfaceId: record.surfaceId
        });
    }

    // ---- operations -------------------------------------------------------

    function opStatus() {
        return Object.freeze({
            ok: true,
            manager: typeof manager.handle === "function" ? "READY" : "UNKNOWN",
            sessionContract: ownerTrust.identityStore ? "WIRED" : "IDENTITY_UNAVAILABLE",
            identityStore: ownerTrust.identityStore ? "DURABLE" : "NONE",
            durable: ownerTrust.durable === true,
            connections: connections.size
        });
    }

    function opAuthBegin(envelope) {
        const deviceId = bounded(envelope.deviceId, "deviceId");
        const surfaceId = bounded(envelope.surfaceId, "surfaceId");
        let challenge;
        try {
            challenge = cliSession.beginChallenge({ deviceId, surfaceId });
        } catch (error) {
            // beginChallenge refuses (fail closed) when no ACTIVE Owner exists
            // or the tokens are malformed — surface the canonical code.
            return deny(error?.code ?? "OT_PROOF_UNAVAILABLE", error?.message ?? "");
        }
        return Object.freeze({
            ok: true,
            challenge: Object.freeze({
                purpose: challenge.purpose,
                credentialId: challenge.credentialId,
                nonce: challenge.nonce,
                context: challenge.context,
                ...(challenge.expiresAtMs === undefined ? {} : { expiresAtMs: challenge.expiresAtMs }),
                deviceId,
                surfaceId
            })
        });
    }

    async function opAuthComplete(envelope) {
        const deviceId = bounded(envelope.deviceId, "deviceId");
        const surfaceId = bounded(envelope.surfaceId, "surfaceId");
        const nonce = bounded(envelope.nonce, "nonce");
        const signature = bounded(envelope.signature, "signature");
        const bindingSecret = bounded(envelope.bindingSecret, "bindingSecret");

        // The device proof-of-possession is checked against the CANONICAL
        // identity aggregate loaded from committed durable state — never a
        // caller-supplied service.
        let identityService;
        try {
            identityService = await ownerTrust.loadCanonicalIdentity();
        } catch {
            return deny("OT_IDENTITY_UNAVAILABLE", "canonical identity state unreadable");
        }
        if (!identityService) {
            return deny("OT_IDENTITY_UNAVAILABLE", "no committed canonical identity state");
        }

        const result = await cliSession.issueSession({
            proof: { nonce, signature },
            deviceId,
            surfaceId,
            bindingSecret,
            identityService
        });
        if (!result || result.ok !== true) {
            return deny(result?.code ?? "OT_SESSION_DENIED");
        }
        if (connections.size >= MAX_CONNECTIONS) {
            const oldest = connections.keys().next().value;
            if (oldest !== undefined) connections.delete(oldest);
        }
        const connectionId = `conn-${crypto.randomBytes(16).toString("hex")}`;
        connections.set(connectionId, Object.freeze({
            session: result.session,
            deviceId,
            surfaceId,
            peer: typeof envelope.peer === "string" && envelope.peer.length <= MAX_TOKEN ? envelope.peer : "cli"
        }));
        const session = result.session;
        return Object.freeze({
            ok: true,
            connectionId,
            sessionId: session.sessionId,
            principalId: session.principalId,
            deviceId: session.deviceId,
            surfaceId: session.surfaceId,
            scope: session.scope,
            expiresAtMs: session.expiresAtMs
        });
    }

    async function opSession(envelope) {
        const connectionId = bounded(envelope.connectionId, "connectionId");
        const record = connections.get(connectionId);
        if (!record) return deny("OT_SESSION_UNKNOWN");
        const verdict = await verifyConnection(record);
        if (verdict.ok !== true) {
            if (["OT_SESSION_EXPIRED", "OT_SESSION_REVOKED", "OT_SESSION_UNKNOWN"].includes(verdict.code)) {
                connections.delete(connectionId);
            }
            return deny(verdict.code);
        }
        return Object.freeze({
            ok: true,
            connectionId,
            sessionId: verdict.sessionId,
            principalId: verdict.principalId,
            deviceId: verdict.deviceId,
            surfaceId: verdict.surfaceId,
            scope: verdict.scope,
            expiresAtMs: verdict.expiresAtMs
        });
    }

    async function opActionChallenge(envelope) {
        const connectionId = bounded(envelope.connectionId, "connectionId");
        const record = connections.get(connectionId);
        if (!record) return deny("OT_SESSION_UNKNOWN");
        const verdict = await verifyConnection(record);
        if (verdict.ok !== true) return deny(verdict.code);

        const owner = ownerTrust.registry.getOwner();
        if (!owner || ownerTrust.registry.getState() !== "ACTIVE") {
            return deny("OT_OWNER_UNAVAILABLE");
        }
        const challenge = ownerTrust.proofVerifier.issueChallenge({
            purpose: "owner-proof",
            credentialId: owner.credentials[0]
        });
        return Object.freeze({
            ok: true,
            challenge: Object.freeze({
                purpose: challenge.purpose,
                credentialId: challenge.credentialId,
                nonce: challenge.nonce,
                context: challenge.context,
                ...(challenge.expiresAtMs === undefined ? {} : { expiresAtMs: challenge.expiresAtMs })
            })
        });
    }

    async function opCapabilities(envelope) {
        const connectionId = bounded(envelope.connectionId, "connectionId");
        const record = connections.get(connectionId);
        if (!record) return deny("OT_SESSION_UNKNOWN");
        const verdict = await verifyConnection(record);
        if (verdict.ok !== true) return deny(verdict.code);

        let descriptors = [];
        try {
            const registry = require("../action/bootstrap")._getCanonicalCapabilityRegistry();
            if (registry && typeof registry.list === "function") descriptors = registry.list();
        } catch {
            descriptors = [];
        }
        const capabilities = descriptors.map((d) => Object.freeze({
            capabilityId: String(d.id ?? "").slice(0, 256),
            kind: String(d.kind ?? "").slice(0, 64),
            availability: String(d.availability ?? "UNKNOWN").slice(0, 32),
            operations: Object.freeze(Array.isArray(d.operations)
                ? d.operations.map((o) => String(o).slice(0, 128)).slice(0, 64)
                : [])
        }));
        return Object.freeze({ ok: true, count: capabilities.length, capabilities: Object.freeze(capabilities) });
    }

    async function opSubmit(envelope) {
        const connectionId = bounded(envelope.connectionId, "connectionId");
        const record = connections.get(connectionId);
        if (!record) return deny("OT_SESSION_UNKNOWN");

        const capabilityId = bounded(envelope.capabilityId, "capabilityId");
        const operation = bounded(envelope.operation, "operation");
        const args = envelope.arguments === undefined ? {} : envelope.arguments;
        if (!isPlainObject(args)) return deny("OT_INGRESS_INVALID", "arguments must be a plain object");
        const authProof = envelope.authProof === undefined ? null : envelope.authProof;
        if (authProof !== null && !isPlainObject(authProof)) {
            return deny("OT_INGRESS_INVALID", "authProof must be a plain object");
        }

        // Revalidate the session against LIVE canonical device trust right
        // before handing the request to the Manager.  This is a decision-time
        // check, NOT an atomic verify-and-execute guarantee.
        const verdict = await verifyConnection(record);
        if (verdict.ok !== true) return deny(verdict.code);

        const input = {
            channelType: CLI_CHANNEL_TYPE,
            channelId: safeChannelId,
            sessionId: connectionId,          // inert transport provenance only
            peer: record.peer,
            correlationId: `cli-${crypto.randomUUID()}`,
            ...(authProof === null ? {} : { authProof }),
            requestedOperation: { capabilityId, operation, arguments: args }
        };

        let result;
        try {
            result = await manager.handle(input);
        } catch (error) {
            return deny("OT_MANAGER_REJECTED", error?.message ?? "");
        }

        return Object.freeze({
            ok: true,
            managerRequestId: result.managerRequestId,
            actionIntentId: result.actionIntentId ?? null,
            executionId: result.executionId ?? null,
            lifecycleState: result.lifecycleState,
            outcome: result.outcome,
            authorityDecision: result.authorityEvidence ? result.authorityEvidence.decision : null,
            authorityReasonCode: result.authorityEvidence ? result.authorityEvidence.reasonCode : null,
            errorReason: result.errorReason ?? "",
            detail: String(result.detail ?? "").slice(0, 256)
        });
    }

    async function opLogout(envelope) {
        const connectionId = bounded(envelope.connectionId, "connectionId");
        const record = connections.get(connectionId);
        if (!record) return Object.freeze({ ok: true, revoked: false });
        const revoked = cliSession.revokeSession(record.session.sessionId);
        connections.delete(connectionId);
        return Object.freeze({ ok: true, revoked: revoked === true });
    }

    const DISPATCH = Object.freeze({
        status: opStatus,
        authBegin: opAuthBegin,
        authComplete: opAuthComplete,
        session: opSession,
        actionChallenge: opActionChallenge,
        capabilities: opCapabilities,
        submit: opSubmit,
        logout: opLogout
    });

    /** Single validated ingress entry. Never throws for a caller-visible denial. */
    async function request(envelope) {
        if (!isPlainObject(envelope)) return deny("OT_INGRESS_INVALID", "envelope must be a plain object");
        const op = envelope.op;
        if (typeof op !== "string" || !OPS.includes(op)) {
            return deny("OT_INGRESS_INVALID", "unknown operation");
        }
        try {
            return await DISPATCH[op](envelope);
        } catch (error) {
            return deny(error?.code ?? "OT_INGRESS_ERROR", error?.message ?? "");
        }
    }

    /** Drop every connection (process-local; also revokes the sessions). */
    function close() {
        for (const record of connections.values()) {
            try { cliSession.revokeSession(record.session.sessionId); } catch { /* best effort */ }
        }
        connections.clear();
    }

    return Object.freeze({ request, close, operations: OPS });
}

module.exports = Object.freeze({ createCliSessionBridge, OPS, CLI_CHANNEL_TYPE });
