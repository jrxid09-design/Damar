"use strict";

/**
 * TRUSTED CROSS-CHANNEL CONTINUITY LINKER (Wave 5 Lane 4, Stage 11; OT-006).
 *
 * Extends Session Continuity ONLY to link AUTHENTICATED conversation sessions
 * bound to the SAME verified principal, subject to an Owner-controlled policy
 * gate.  The linker issues a NARROW, EXPLICIT, EXPIRING, ONE-USE link
 * authorization that the continuity engine consumes — it does not redesign
 * session storage and never moves conversation context itself.
 *
 * RAW STRING != TRUSTED PEER HANDLE (OT-006):
 *   Authorization requires canonical TransportPeerProvenance for EVERY
 *   session being linked — the Owner must be LIVE on every channel at
 *   authorize time.  Session keys alone are never evidence.
 *
 * LAWS (binding):
 *   SESSION CONTINUITY != AUTHENTICATION.
 *     A continued/linked session is NEVER proof of authentication:
 *       - at AUTHORIZATION time every participating session must present
 *         live canonical provenance that authenticates to the same ACTIVE
 *         principal;
 *       - at CONSUMPTION time the consuming channel must present live
 *         canonical provenance again; the other channels are re-checked as
 *         PERSISTED bindings (active, generation-current, principal ACTIVE).
 *         Live re-minting of provenance for a channel with no current
 *         traffic is impossible by construction — pretending otherwise
 *         would fabricate evidence, so the honest contract is: live proof
 *         for the speaking channel, persisted trust for the silent ones.
 *   PERSISTED TRUST != LIVE AUTHENTICATION.
 *     Continuity history from a previous epoch confers nothing; only the
 *     live binding check counts for the consuming channel.
 *   LINKAGE IS POLICY-GATED BY THE OWNER:
 *     Cross-channel linking is DISABLED by default.  Enabling/disabling it is
 *     a trust mutation that requires an authenticated Owner proof — a model
 *     output, channel payload, or caller option can never flip it.
 *
 * Only sessions whose channel maps to a canonical binder transport
 * (console | telegram | whatsapp) can participate; other channels fail
 * closed rather than being linked on unauthenticated evidence.
 */

const crypto = require("node:crypto");

const { parseSessionKeyPart, LINKABLE_CHANNELS } = require("./sessionKeys");
const { verifyTransportPeerProvenance } = require("./provenance");

const LINK_TTL_MS = 60_000;
const MIN_SESSIONS = 2;
const MAX_SESSIONS = 4;

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
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

    /** Persisted-binding re-check for a non-live session (consume time). */
    function persistedCheck(sessionKey) {
        const { channel, peer } = parseSessionKeyPart(sessionKey);
        const binding = registry.findBinding({ kind: "transport", peer: `${channel}:${peer}` });
        if (!binding) return "OT_PEER_NOT_BOUND";
        if (binding.revokedAtMs !== null) return "OT_BINDING_REVOKED";
        const principal = registry.getPrincipal(binding.principalId);
        if (!principal || !Number.isSafeInteger(principal.generation) ||
            binding.generation < principal.generation) {
            return "OT_GENERATION_STALE";
        }
        if (registry.principalState(binding.principalId) !== "ACTIVE") {
            return "OT_PRINCIPAL_NOT_ACTIVE";
        }
        return null;
    }

    /**
     * Authorize linking conversation sessions.  EVERY session key must be
     * paired with LIVE canonical provenance (minted by its transport adapter
     * at current ingress) that authenticates to the SAME verified ACTIVE
     * principal.  Returns a one-use, expiring link authorization for the
     * continuity engine, or a fail-closed verdict.
     */
    function authorizeLink({ sessionKeys, provenances } = {}) {
        const now = clock();
        sweepExpired(now);
        if (!Array.isArray(sessionKeys)) {
            return Object.freeze({ ok: false, code: "OT_LINK_INVALID" });
        }
        if (sessionKeys.length < MIN_SESSIONS || sessionKeys.length > MAX_SESSIONS) {
            return Object.freeze({ ok: false, code: "OT_LINK_BOUND" });
        }
        if (!Array.isArray(provenances)) {
            return Object.freeze({ ok: false, code: "OT_LINK_INVALID" });
        }
        if (!linkPolicyEnabled) {
            return Object.freeze({ ok: false, code: "OT_LINK_POLICY_DISABLED" });
        }
        const parsed = [];
        for (const key of sessionKeys) {
            try {
                parsed.push({ key, ...parseSessionKeyPart(key) });
            } catch (error) {
                return Object.freeze({ ok: false, code: error.code ?? "OT_SESSION_KEY_INVALID" });
            }
        }
        // Index live provenance by (transport, peerKey) — keyed by the
        // ORIGINAL object so the binder's brand check re-verifies it.
        const live = new Map();
        for (const p of provenances) {
            const view = verifyTransportPeerProvenance(p);
            if (!view) {
                return Object.freeze({ ok: false, code: "OT_PROVENANCE_INVALID" });
            }
            live.set(`${view.transport}\u0000${view.peerKey}`, p);
        }
        // LIVE re-authentication of EVERY participating peer — continuity is
        // never proof, and a session key alone is never evidence.
        let principalId = null;
        for (const s of parsed) {
            const original = live.get(`${s.channel}\u0000${s.peer}`);
            if (!original) {
                return Object.freeze({ ok: false, code: "OT_LINK_PROVENANCE_MISSING" });
            }
            const auth = principalBindings.authenticateTransportPeer({ provenance: original });
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
     * expiry, from the LIVE channel: `provenance` is the canonical
     * provenance minted by the consuming transport adapter.  A
     * consumed/expired/unknown link or a non-authenticating consuming
     * channel fails closed.  Other participating sessions are re-checked as
     * persisted bindings (active, generation-current, principal ACTIVE).
     */
    function consumeLink({ linkId, provenance } = {}) {
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
        // LIVE re-authentication of the CONSUMING channel: PERSISTED TRUST !=
        // LIVE AUTHENTICATION.
        const auth = principalBindings.authenticateTransportPeer({ provenance });
        if (!auth.ok || auth.principalId !== link.principalId) {
            links.delete(linkId);
            return Object.freeze({ ok: false, code: "OT_LINK_REVOKED" });
        }
        // The consuming provenance must correspond to one of the linked
        // sessions (no linking consumption from an unrelated peer).
        const view = verifyTransportPeerProvenance(provenance);
        const consumingKey = `${view.transport}\u0000${view.peerKey}`;
        let isParticipant = false;
        for (const key of link.sessionKeys) {
            const { channel, peer } = parseSessionKeyPart(key);
            if (`${channel}\u0000${peer}` === consumingKey) { isParticipant = true; break; }
        }
        if (!isParticipant) {
            links.delete(linkId);
            return Object.freeze({ ok: false, code: "OT_LINK_FOREIGN_CHANNEL" });
        }
        // Persisted re-check for every OTHER session.
        for (const key of link.sessionKeys) {
            const { channel, peer } = parseSessionKeyPart(key);
            if (`${channel}\u0000${peer}` === consumingKey) continue;
            const problem = persistedCheck(key);
            if (problem !== null) {
                links.delete(linkId);
                return Object.freeze({ ok: false, code: problem });
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

module.exports = Object.freeze({ createContinuityLinker, LINKABLE_CHANNELS });
