"use strict";
// MCP Lane 2 composition lane for the HTTP daemon (wiring, 2026-11-24).
//
// attachMcp() runs synchronously while the canonical Owner Trust
// composition resolves asynchronously, so app.js cannot hand attachMcp
// the real grant verifier directly. This module provides the lazy lane:
//
//   - managerHandle: forwards the adapter's ManagerRequest to the
//     canonical production Manager singleton (created on first use).
//   - grantVerifier facade: verify() delegates to the canonical
//     composition's grant verifier once composed; before that (or when
//     no Owner is enrolled / no grant lane was composed) it returns
//     null - fail-closed, exactly like resolveOwnerAuthVerifier().
//     issueChallenge() delegates the same way and throws a typed
//     MCP_GRANT_LANE_NOT_READY error while the lane is unavailable, so
//     a challenge request fails loudly instead of minting a nonce no
//     verifier would ever accept.
//
// The facade holds no authority and no key material: the real verifier
// (with its one-use nonce gate) lives inside the canonical composition,
// and the SAME instance serves both this facade's challenges and the
// Manager's authentication path (via resolveOwnerAuthVerifier), so a
// nonce issued here is verifiable there.
const { ensureCanonicalComposed } = require("../authority/ownerTrustComposition");

function createLazyGrantLane() {
    let composed = null;
    let composing = null;

    function kickComposition() {
        if (composed !== null || composing !== null) return;
        composing = Promise.resolve()
            .then(() => ensureCanonicalComposed())
            .then((comp) => { composed = comp; })
            .catch(() => { composed = null; })
            .finally(() => { composing = null; });
    }
    kickComposition();

    function liveVerifier() {
        kickComposition();
        if (!composed || !composed.grantVerifier) return null;
        return composed.grantVerifier;
    }

    const grantVerifier = Object.freeze({
        verify(evidence) {
            const verifier = liveVerifier();
            return verifier ? verifier.verify(evidence) : null;
        },
        issueChallenge() {
            const verifier = liveVerifier();
            if (!verifier) {
                const err = new Error("MCP_GRANT_LANE_NOT_READY: canonical composition or grant lane unavailable");
                err.code = "MCP_GRANT_LANE_NOT_READY";
                throw err;
            }
            return verifier.issueChallenge();
        },
    });

    async function managerHandle(request) {
        const { createDamarManager } = require("../manager");
        return createDamarManager().handle(request);
    }

    return Object.freeze({ managerHandle, grantVerifier });
}

module.exports = { createLazyGrantLane };
