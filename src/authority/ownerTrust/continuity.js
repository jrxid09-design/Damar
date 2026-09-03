"use strict";

/**
 * TRUSTED CROSS-CHANNEL CONTINUITY LINKER (Wave 5 Lane 4, Stage 11).
 *
 * Extends Session Continuity ONLY to link AUTHENTICATED conversation sessions
 * bound to the SAME verified principal, subject to an Owner-controlled policy
 * gate.  The linker issues a NARROW, EXPLICIT, EXPIRING, ONE-USE link
 * authorization that the continuity engine consumes — it does not redesign
 * session storage and never moves conversation context itself.
 *
 * LAWS (binding):
 *   SESSION CONTINUITY != AUTHENTICATION.
 *     A continued/linked session is NEVER proof of authentication: EVERY
 *     session key in a link is re-authenticated through the CURRENT transport
 *     binding (active, principal ACTIVE, principal generation current) at
 *     authorization time.  A stale/revoked/not-active peer fails the whole
 *     link fail-closed.
 *   PERSISTED TRUST != LIVE AUTHENTICATION.
 *     Continuity history from a previous epoch confers nothing; only the
 *     live binding check counts.
 *   LINKAGE IS POLICY-GATED BY THE OWNER:
 *     Cross-channel linking is DISABLED by default.  Enabling/disabling it is
 *     a trust mutation that requires an authenticated Owner proof — a model
 *     output, channel payload, or caller option can never flip it.
 *
 * Only sessions whose channel maps to a canonical binder transport
 * (console | telegram | whatsapp) can participate; other channels fail
 * closed rather than being linked on unauthenticated evidence.
 */

const LINK_TTL_MS = 60_000;
const MIN_SESSIONS = 2;
const MAX_SESSIONS = 4;
const LINKABLE_CHANNELS = Object.freeze(["console", "telegram", "whatsapp"]);

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

/** Parse `channel:<kanal>:<kind>:<peer>` (SessionStore.sessionKey grammar). */
function parseSessionKey(key) {
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
        throw fail("OT_SESSION_KEY_INVALID", "session key malformed");
    }
    const parts = key.split(":");
    if (parts.length < 4 || parts[0] !== "channel") {
        throw fail("OT_SESSION_KEY_INVALID", "session key grammar mismatch");
    }
    const channel = parts[1];
    const kind = parts[2];
    const peer = parts.slice(3).join(":");
    if (!LINKABLE_CHANNELS.includes(channel)) {
        throw fail("OT_CHANNEL_NOT_LINKABLE", `channel '${channel}' has no canonical binder`);
    }
    if (kind !== "dm" && kind !== "group") {
        throw fail("OT_SESSION_KEY_INVALID", "session kind must be dm|group");
    }
    if (typeof peer !== "string" || peer.length === 0) {
        throw fail("OT_SESSION_KEY_INVALID", "session peer empty");
    }
    return { channel, kind, peer };
}

/**
 * createContinuityLinker({ registry, principalBindings, clock })
 *
 *   registry           — OwnerTrustRegistry (policy + generation source).
 *   principalBindings  — the composition-bound principal bindings (the ONLY
 *                        authentication path for peers).
 *   clock              — () => ms.
 */
function createContinuityLinker({ registry, principalBindings, clock = () => Date.now() } = {}) {
    if (!registry || typeof registry.getOwner !== "function") {
        throw fail("OT_LINKER_INVALID", "linker requires an OwnerTrustRegistry");
    }
    if (!principalBindings || typeof principalBindings.authenticateTransportPeer !== "function") {
        throw fail("OT_LINKER_INVALID", "linker requires principal bindings");
    }

    // Owner policy: cross-channel linking DISABLED until the Owner enables it.
    let linkPolicyEnabled = false;
    let policyGeneration = 0;

    // linkId -> { principalId, sessionKeys, expiresAtMs, consumed }
    const links = new Map();

    const LINK_TTL_GRACE_MS = LINK_TTL_MS;

    function sweepExpired(now) {
        // Grace window: links are swept only after DOUBLE their TTL, so a
        // just-expired link still reports OT_LINK_EXPIRED and a consumed link
        // still reports OT_LINK_REPLAY rather than a misleading
        // OT_LINK_UNKNOWN.
        for (const [id, link] of links) {
            if (now >= link.expiresAtMs + LINK_TTL_GRACE_MS) links.delete(id);
        }
    }

    /**
     * Owner-gated policy mutation (requires a genuine owner-proof).  A model
     * output, channel payload, or caller option can NEVER flip this policy.
     */
    async function setLinkPolicy({ proof, enabled }) {
        const owner = registry.getOwner();
        if (!owner || registry.getState() !== "ACTIVE") {
            throw fail("OT_NOT_ACTIVE", "no active Owner; link policy is frozen");
        }
        const verdict = principalBindings.requireAuthenticatedPrincipal({
            proof, purpose: "owner-proof"
        });
        if (verdict !== owner.principalId) {
            throw fail("OT_NOT_OWNER", "only the active Owner may change link policy");
        }
        if (typeof enabled !== "boolean") {
            throw fail("OT_POLICY_INVALID", "enabled must be a boolean");
        }
        linkPolicyEnabled = enabled;
        policyGeneration += 1;
        // Disabling invalidates ALL outstanding link authorizations.
        if (!enabled) links.clear();
        return Object.freeze({ enabled: linkPolicyEnabled, generation: policyGeneration });
    }

    function getLinkPolicy() {
        return Object.freeze({ enabled: linkPolicyEnabled, generation: policyGeneration });
    }

    /**
     * Authorize linking conversation sessions.  EVERY session key is
     * re-authenticated NOW through its current transport binding; all must
     * resolve to the SAME verified ACTIVE principal.  Returns a one-use,
     * expiring link authorization for the continuity engine, or a fail-closed
     * verdict.
     */
    function authorizeLink({ sessionKeys } = {}) {
        const now = clock();
        sweepExpired(now);
        if (!Array.isArray(sessionKeys)) {
            return Object.freeze({ ok: false, code: "OT_LINK_INVALID" });
        }
        if (sessionKeys.length < MIN_SESSIONS || sessionKeys.length > MAX_SESSIONS) {
            return Object.freeze({ ok: false, code: "OT_LINK_BOUND" });
        }
        if (!linkPolicyEnabled) {
            return Object.freeze({ ok: false, code: "OT_LINK_POLICY_DISABLED" });
        }
        const parsed = [];
        for (const key of sessionKeys) {
            try {
                parsed.push({ key, ...parseSessionKey(key) });
            } catch (error) {
                return Object.freeze({ ok: false, code: error.code ?? "OT_SESSION_KEY_INVALID" });
            }
        }
        // LIVE re-authentication of EVERY peer — continuity is never proof.
        let principalId = null;
        for (const s of parsed) {
            const auth = principalBindings.authenticateTransportPeer({
                transport: s.channel, peer: s.peer
            });
            if (!auth.ok) {
                return Object.freeze({ ok: false, code: auth.code ?? "OT_LINK_UNAUTHENTICATED" });
            }
            if (principalId === null) {
                principalId = auth.principalId;
            } else if (auth.principalId !== principalId) {
                // Cross-PRINCIPAL linking is forbidden outright.
                return Object.freeze({ ok: false, code: "OT_LINK_PRINCIPAL_MISMATCH" });
            }
        }
        if (registry.principalState(principalId) !== "ACTIVE") {
            return Object.freeze({ ok: false, code: "OT_PRINCIPAL_NOT_ACTIVE" });
        }
        const crypto = require("node:crypto");
        const linkId = `link-${crypto.randomBytes(12).toString("hex")}`;
        const expiresAtMs = now + LINK_TTL_MS;
        links.set(linkId, Object.freeze({
            principalId, sessionKeys: Object.freeze([...sessionKeys]), expiresAtMs, consumed: false
        }));
        return Object.freeze({
            ok: true, linkId, principalId,
            sessionKeys: Object.freeze([...sessionKeys]), expiresAtMs
        });
    }

    /**
     * Continuity engine consumes a link authorization EXACTLY once, before
     * expiry.  A consumed/expired/unknown link fails closed.
     */
    function consumeLink({ linkId } = {}) {
        const now = clock();
        sweepExpired(now);
        const link = links.get(linkId);
        if (!link) {
            return Object.freeze({ ok: false, code: "OT_LINK_UNKNOWN" });
        }
        if (link.consumed) {
            return Object.freeze({ ok: false, code: "OT_LINK_REPLAY" });
        }
        if (now >= link.expiresAtMs) {
            links.delete(linkId);
            return Object.freeze({ ok: false, code: "OT_LINK_EXPIRED" });
        }
        // LIVE re-authentication at consumption time: PERSISTED TRUST !=
        // LIVE AUTHENTICATION.  Every bound peer must STILL authenticate to
        // the SAME ACTIVE principal — a binding revoked, staled by
        // generation, or left inactive between authorization and consumption
        // invalidates the link fail-closed.
        for (const key of link.sessionKeys) {
            const { channel, peer } = parseSessionKey(key);
            const auth = principalBindings.authenticateTransportPeer({ transport: channel, peer });
            if (!auth.ok || auth.principalId !== link.principalId) {
                links.delete(linkId);
                return Object.freeze({ ok: false, code: "OT_LINK_REVOKED" });
            }
        }
        if (!linkPolicyEnabled || registry.principalState(link.principalId) !== "ACTIVE") {
            links.delete(linkId);
            return Object.freeze({ ok: false, code: "OT_LINK_REVOKED" });
        }
        links.set(linkId, Object.freeze({ ...link, consumed: true }));
        return Object.freeze({
            ok: true, principalId: link.principalId,
            sessionKeys: link.sessionKeys
        });
    }

    return Object.freeze({
        setLinkPolicy, getLinkPolicy, authorizeLink, consumeLink
    });
}

module.exports = Object.freeze({ createContinuityLinker, parseSessionKey, LINKABLE_CHANNELS });
