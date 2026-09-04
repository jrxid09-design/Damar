"use strict";

/**
 * TRANSPORT-OWNED PEER PROVENANCE (Wave 5 Lane 4 repair, OT-006).
 *
 * RAW STRING != TRUSTED PEER HANDLE.
 *
 * A TransportPeerProvenance is an OPAQUE, BRANDED object minted INTERNALLY
 * by a canonical transport adapter at the moment it receives traffic from
 * its OWN transport-library context (Telegram update object, Baileys
 * messages.upsert entry, local console runtime session).  It is the ONLY
 * peer identity shape the trust binders accept.
 *
 * BRANDING CANNOT BE RECREATED FROM SHAPE:
 *   - membership in a module-closure WeakSet (not enumerable, not
 *     serializable, not clonable — structuredClone/spread/JSON round-trips
 *     all lose it);
 *   - a module-private Symbol key that is never exported (a counterfeiter
 *     can create a *different* symbol with the same description; it will
 *     not match);
 *   - the mint capability is held ONLY by canonical adapters, which receive
 *     their issuer from the canonical composition — it is never on any
 *     public facade, never accepted from caller envelopes, never reachable
 *     from Manager/model/plugins.
 *
 * HONEST RESIDUAL (documented): a fully privileged in-process attacker with
 * arbitrary require access to this internal module could call
 * createTransportProvenanceIssuer directly.  Provenance minting alone
 * confers NOTHING — authentication still requires a stored binding whose
 * fingerprint matches AND a current principal proof.  The defended class is
 * exactly the audit's: caller JSON, raw chatId/jid strings, model-produced
 * objects, cloned/copied fields, cross-transport confusion.
 */

const crypto = require("node:crypto");

const BRAND = Symbol("damar.transportPeerProvenance.v1");
/** Module-closure membership registry — the actual brand. */
const BRANDED = new WeakSet();

const TRANSPORT_IDS = Object.freeze(["console", "telegram", "whatsapp"]);

function provenanceError(code, message) {
    const error = new Error(`[${code}] ${message}`);
    error.code = code;
    return error;
}

/**
 * Create a provenance issuer for ONE canonical transport adapter instance.
 * Only the canonical composition hands these out; each issuer is bound to a
 * single transport id and an adapter instance id.
 */
function createTransportProvenanceIssuer({ transport, instanceId } = {}) {
    if (typeof transport !== "string" || !TRANSPORT_IDS.includes(transport)) {
        throw provenanceError("OT_PROVENANCE_TRANSPORT_INVALID",
            "issuer transport must be console|telegram|whatsapp");
    }
    if (typeof instanceId !== "string" || instanceId.length === 0 || instanceId.length > 128) {
        throw provenanceError("OT_PROVENANCE_TRANSPORT_INVALID", "issuer instanceId required");
    }
    /**
     * Mint a provenance object from the adapter's OWN context.
     * ctx: { peerKey — the NORMALIZED transport-owned peer identity string
     *        (adapter-specific normalization happens in the adapter),
     *        incarnation — connection/session incarnation context (opaque) }.
     * peerKey must be printable-ASCII, bounded (the same discipline the
     * trust domain historically enforced on normalized peers).
     */
    function mint(ctx = {}) {
        const peerKey = ctx.peerKey;
        if (typeof peerKey !== "string" || peerKey.length === 0 || peerKey.length > 128 ||
            !/^[\x21-\x7E]+$/.test(peerKey)) {
            throw provenanceError("OT_PROVENANCE_CONTEXT_INVALID",
                "mint requires the adapter's normalized peerKey (printable ASCII, <= 128)");
        }
        const obj = Object.freeze({
            transport,
            peerKey,
            incarnation: typeof ctx.incarnation === "string" ? ctx.incarnation : null,
            instanceId,
            mintedAtMs: Date.now(),
            [BRAND]: true
        });
        BRANDED.add(obj);
        return obj;
    }
    return Object.freeze({ transport, instanceId, mint });
}

/**
 * Domain-internal verification: returns the normalized provenance view or
 * null.  Rejects clones, JSON reconstructions, plain objects, and any object
 * not minted by a canonical issuer.
 */
function verifyTransportPeerProvenance(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return null;
    }
    if (candidate[BRAND] !== true || !BRANDED.has(candidate)) {
        return null;
    }
    const { transport, peerKey, incarnation, instanceId } = candidate;
    if (typeof transport !== "string" || !TRANSPORT_IDS.includes(transport) ||
        typeof peerKey !== "string" || peerKey.length === 0 ||
        typeof instanceId !== "string") {
        return null;
    }
    return Object.freeze({ transport, peerKey, incarnation: incarnation ?? null, instanceId });
}

/** Loose predicate (no disclosure). */
function isTransportPeerProvenance(candidate) {
    return verifyTransportPeerProvenance(candidate) !== null;
}

/**
 * Stable canonical peer fingerprint — the ONLY thing stored in bindings.
 * The opaque runtime object itself is never persisted.
 */
function transportPeerFingerprint(candidate) {
    const view = verifyTransportPeerProvenance(candidate);
    if (!view) return null;
    return crypto.createHash("sha256")
        .update(`${view.transport}\u0000${view.peerKey}`)
        .digest("hex");
}

module.exports = Object.freeze({
    TRANSPORT_IDS,
    createTransportProvenanceIssuer,
    verifyTransportPeerProvenance,
    isTransportPeerProvenance,
    transportPeerFingerprint
});
