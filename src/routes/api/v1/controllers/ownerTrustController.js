"use strict";

/**
 * OWNER TRUST HTTP SURFACE (Wave 5 Lane 4) — the canonical console routes
 * for trust provisioning and status.  Mounted under /api/v1/console, so
 * every request is already token-guarded (token = owner credential).
 *
 * SECURITY MODEL:
 *   - The console token authenticates the OPERATOR to the daemon; it does
 *     NOT by itself authenticate the OWNER principal.  Mutating trust
 *     routes additionally require a genuine owner-proof.  For the vault
 *     mode the daemon supplies that proof ITSELF (selfSignOwnerProof —
 *     possession of the vault-sealed root, never exposed).
 *   - The bootstrap ceremony accepts ONLY { principalId, mode } for begin
 *     and { ceremonyId } for complete (vault mode).  No key material is
 *     ever accepted over HTTP.
 *   - Remote transport peers (telegram/whatsapp) can ONLY be bound from
 *     LIVE transport ingress (OT-006) — never from an HTTP payload, which
 *     would be a caller-supplied ID masquerading as transport evidence.
 *     The console surface binds its own locally-minted provenance.
 *   - Every response is fail-closed: uncomposed/locked surfaces return
 *     explicit error codes, never silent success.
 */

const { ensureCanonicalComposed } = require("../../authority/ownerTrustComposition");

function fail(res, code, message, status = 400) {
    return res.status(status).json({ ok: false, code, message });
}

async function trustStatus(_req, res) {
    try {
        const comp = await ensureCanonicalComposed();
        const registry = comp.registry;
        const owner = registry.getOwner();
        const snap = registry.snapshot();
        return res.json({
            ok: true,
            state: snap.state,
            bootstrapped: snap.bootstrapped,
            generation: snap.generation,
            owner: owner ? { principalId: owner.principalId, enrolledAtMs: owner.enrolledAtMs } : null,
            admins: snap.admins.map((a) => ({
                principalId: a.principalId, delegatedBy: a.delegatedBy, state: a.state
            })),
            bindings: snap.bindings.map((b) => ({
                bindingId: b.bindingId, principalId: b.principalId, kind: b.kind,
                peer: b.peer, revokedAtMs: b.revokedAtMs
            })),
            linkPolicy: comp.continuityLinker.getLinkPolicy(),
            audit: comp.auditGate.health(),
            durable: comp.durable
        });
    } catch (error) {
        return fail(res, error && error.code ? error.code : "OT_INTERNAL",
            error && error.message ? error.message : "owner trust status unavailable", 500);
    }
}

async function bootstrapBegin(req, res) {
    try {
        const comp = await ensureCanonicalComposed();
        const { principalId, mode, publicKeyPem } = req.body ?? {};
        if (typeof principalId !== "string" || principalId.length === 0) {
            return fail(res, "OT_CEREMONY_INVALID", "principalId required");
        }
        const challenge = await comp.firstOwnerBootstrap.begin({
            principalId,
            mode: mode === "external" ? "external" : "damar-vault",
            publicKeyPem: mode === "external" ? publicKeyPem : undefined
        });
        return res.json({ ok: true, ...challenge });
    } catch (error) {
        return fail(res, error && error.code ? error.code : "OT_INTERNAL",
            error && error.message ? error.message : "bootstrap begin failed");
    }
}

async function bootstrapComplete(req, res) {
    try {
        const comp = await ensureCanonicalComposed();
        const { ceremonyId, signature } = req.body ?? {};
        if (typeof ceremonyId !== "string" || ceremonyId.length === 0) {
            return fail(res, "OT_CEREMONY_UNKNOWN", "ceremonyId required");
        }
        const result = await comp.firstOwnerBootstrap.complete({
            ceremonyId, signature: typeof signature === "string" ? signature : null
        });
        return res.json({ ok: true, ...result });
    } catch (error) {
        return fail(res, error && error.code ? error.code : "OT_INTERNAL",
            error && error.message ? error.message : "bootstrap complete failed");
    }
}

async function bindConsole(req, res) {
    try {
        const comp = await ensureCanonicalComposed();
        const proof = await comp.selfSignOwnerProof({ purpose: "owner-proof" });
        if (!proof) {
            return fail(res, "OT_NOT_ACTIVE",
                "no active vault-mode Owner; self-proof unavailable", 409);
        }
        const provenance = comp.ingress.mintConsoleProvenance({
            incarnation: typeof req.id === "string" ? req.id : null
        });
        const binding = await comp.channelBinders.console.bind({
            proof, purpose: "owner-proof", provenance
        });
        return res.json({ ok: true, ...binding });
    } catch (error) {
        return fail(res, error && error.code ? error.code : "OT_INTERNAL",
            error && error.message ? error.message : "console binding failed");
    }
}

async function setLinkPolicy(req, res) {
    try {
        const comp = await ensureCanonicalComposed();
        const { enabled } = req.body ?? {};
        if (typeof enabled !== "boolean") {
            return fail(res, "OT_POLICY_INVALID", "enabled must be a boolean");
        }
        const proof = await comp.selfSignOwnerProof({ purpose: "owner-proof" });
        if (!proof) {
            return fail(res, "OT_NOT_ACTIVE",
                "no active vault-mode Owner; self-proof unavailable", 409);
        }
        const policy = await comp.continuityLinker.setLinkPolicy({ proof, enabled });
        return res.json({ ok: true, ...policy });
    } catch (error) {
        return fail(res, error && error.code ? error.code : "OT_INTERNAL",
            error && error.message ? error.message : "link policy change failed");
    }
}

module.exports = Object.freeze({
    trustStatus,
    bootstrapBegin,
    bootstrapComplete,
    bindConsole,
    setLinkPolicy
});
