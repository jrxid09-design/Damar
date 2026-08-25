/**
 * AUTHORITY REGISTRY V1 â€” satu pintu lifecycle + keputusan otoritas.
 *
 *   - REQUEST != GRANT ; PROPOSAL != AUTHORITY
 *   - Delegasi hanya via attenuateGrant (subset law)
 *   - Root grant baru HANYA dari OwnerRatification APPROVED yang
 *     ter-bind ke digest revisi proposal saat ini
 *   - consumeExecution atomik ; generation bump = bulk revoke instan
 */

const crypto = require("node:crypto");
const M = require("./model");
const { attenuateGrant } = require("./delegation");
const { canonicalCapabilityId, canonicalTokenList,
        canonicalRestrictionSet,
        restoreCanonicalRestrictionSet,
        deepFreeze } = require("./canonical");

class AuthorityRegistry {

    constructor({ store, clock }) {
        this.store = store;
        this.clock = clock;
    }

    nowIso() { return this.clock.nowIso(); }

    ev(type, capabilityId, actor, payload) {
        return {
            eventId: crypto.randomUUID(), type,
            capability_id: capabilityId ?? null,
            actor: String(actor ?? "registry").slice(0, 120),
            at: this.nowIso(), payload: payload ?? {}
        };
    }

    /* ------------------------ GENERATION (Â§G) --------------------------- */

    async revokeSubjectGeneration(subject, actor = "owner") {
        const g = await this.store.bumpGeneration(subject, this.nowIso());
        await this.store.appendEvent(this.ev(
            "SUBJECT_GENERATION_BUMPED", null, actor,
            { subject, newGeneration: g }));
        return g;
    }

    /* --------------------- RATIFIED ROOT GRANT (Â§E) ---------------------- */

    /**
     * SATU-SATUNYA jalur authority > previous. Ratifikasi wajib APPROVED
     * dan ter-bind ke digest revisi proposal SAAT RATIFIKASI; bila proposal
     * berubah material sesudahnya -> CAP_RATIFICATION_REQUIRED (stale).
     */
    async issueRatifiedRootGrant({ proposalId, requestedAuthority = null,
                                   ratificationId, actor = "owner" }) {

        const deny = (reasonCode, detail) => ({
            allowed: false, reasonCode, detail: detail ?? null,
            decisionId: crypto.randomUUID(), stage: "ratification",
            grant: null });

        const proposal = await this.store.getProposal(proposalId);
        if (!proposal) return deny("CAP_NOT_FOUND", "proposal tidak ditemukan");

        const rat = await this.store.getRatification(ratificationId);
        if (!rat || rat.decision !== "APPROVED") {
            return deny("CAP_RATIFICATION_REQUIRED",
                "ratifikasi APPROVED tidak ditemukan");
        }
        if (rat.proposalDigest !== proposal.digest) {
            return deny("CAP_RATIFICATION_REQUIRED",
                "digest proposal berubah setelah ratifikasi (stale)");
        }
        if (rat.expiryAt && Date.parse(rat.expiryAt) < this.clock.nowMs()) {
            return deny("CAP_RATIFICATION_REQUIRED", "ratifikasi kedaluwarsa");
        }
        if (rat.proposalId !== proposalId) {
            return deny("CAP_MALFORMED", "ratifikasi milik proposal lain");
        }

        const requested = requestedAuthority ?? proposal.requestedAuthority;
        if (!requested || !requested.capabilityId || !requested.subject ||
            !Array.isArray(requested.actions) || !requested.actions.length) {
            return deny("CAP_MALFORMED", "requestedAuthority tidak lengkap");
        }

        const subjectGen =
            await this.store.getGeneration(String(requested.subject));

        const grant = M.buildGrant({
            capabilityId: requested.capabilityId,
            kind: "root",
            subject: requested.subject,
            issuer: "owner-ratification:" + ratificationId.slice(0, 60),
            actions: requested.actions,
            scope: requested.scope ?? [],
            allowedPurposes: requested.allowedPurposes ?? [],
            restrictions: requested.restrictions ?? null,
            maxExecutions: requested.maxExecutions ?? null,
            issuedAt: this.nowIso(),
            notBefore: requested.notBefore ?? null,
            expiresAt: requested.expiresAt ?? rat.expiryAt ?? null,
            generation: subjectGen,
            delegationDepth: 0,
            remainingDelegationDepth:
                Number.isInteger(requested.remainingDelegationDepth)
                    ? requested.remainingDelegationDepth : 2,
            purpose: requested.purpose ?? null,
            identityBinding: requested.identityBinding ?? null,
            ratificationId,
            extra: { proposalDigest: proposal.digest }
        });

        await this.store.upsertCapability(grant.capabilityId,
            grant.status, grant.generation, JSON.stringify(grant));
        await this.store.appendEvent(this.ev("CAPABILITY_GRANTED",
            grant.capabilityId, actor,
            { kind: "root", ratificationId,
              proposalDigest: proposal.digest }));

        return { allowed: true, reasonCode: "GRANTED_ROOT",
                 decisionId: crypto.randomUUID(),
                 capabilityId: grant.capabilityId,
                 stage: "ratified-root", grant };

    }

    /**
     * Load + revalidate parent grant sebelum delegasi.
     * Persistence/audit bukan authority; state capability + generation
     * harus masih sah pada saat delegasi dilakukan.
     */
    async loadGrant(capabilityId) {

        const deny = (reasonCode, detail = null, stage = "parent-load") => ({
            ok: false,
            allowed: false,
            reasonCode,
            detail,
            decisionId: crypto.randomUUID(),
            stage,
            grant: null
        });

        let capId;
        try {
            capId = canonicalCapabilityId(capabilityId);
        } catch (error) {
            return deny("CAP_MALFORMED", error.message, "normalize");
        }

        const cap = await this.store.getCapability(capId);
        if (!cap) {
            return deny("CAP_NOT_FOUND", null, "lookup");
        }

        const g = cap.payload;
        if (!g || typeof g !== "object" || Array.isArray(g)) {
            return deny("CAP_MALFORMED",
                "payload grant tidak sah", "hydrate");
        }

        let grant;
        try {
            if (!g.subject || !g.capabilityId) {
                throw new Error("grant kehilangan subject/capabilityId");
            }

            const payloadId = canonicalCapabilityId(g.capabilityId);
            if (payloadId !== capId) {
                throw new Error(
                    `payload capabilityId ${payloadId} != key ${capId}`);
            }

            const actions = canonicalTokenList(g.actions ?? [], "actions");
            if (!actions.length) {
                throw new Error("grant tidak memiliki action");
            }

            grant = deepFreeze({
                ...g,
                capabilityId: capId,
                status: cap.status,
                generation: cap.generation,
                actions,
                scope: canonicalTokenList(g.scope ?? [], "scope"),
                allowedPurposes:
                    canonicalTokenList(
                        g.allowedPurposes ?? [], "allowedPurposes"),
                restrictions:
                    restoreCanonicalRestrictionSet(g.restrictions)
            });
        } catch (error) {
            return deny("CAP_MALFORMED", error.message, "hydrate");
        }

        const currentGeneration =
            await this.store.getGeneration(grant.subject);

        if (currentGeneration !== cap.generation) {
            return deny(
                "CAP_GENERATION_STALE",
                `gen ${cap.generation} != current ${currentGeneration}`,
                "generation"
            );
        }

        if (cap.status === M.STATUS.SUSPENDED) {
            return deny("CAP_INACTIVE", null, "status");
        }

        if (cap.status === M.STATUS.REVOKED) {
            return deny("CAP_REVOKED", null, "status");
        }

        if (cap.status === M.STATUS.EXPIRED) {
            return deny("CAP_EXPIRED", null, "status");
        }

        if (cap.status === M.STATUS.EXHAUSTED) {
            return deny("CAP_EXHAUSTED", null, "status");
        }

        if (cap.status !== M.STATUS.ACTIVE) {
            return deny("CAP_INACTIVE",
                `status tidak dikenal/aktif: ${String(cap.status)}`,
                "status");
        }

        const nowMs = this.clock.nowMs();

        if (grant.notBefore &&
            nowMs < Date.parse(grant.notBefore)) {
            return deny("CAP_INACTIVE",
                grant.notBefore, "notBefore");
        }

        if (grant.expiresAt &&
            nowMs > Date.parse(grant.expiresAt)) {
            return deny("CAP_EXPIRED",
                grant.expiresAt, "expiry");
        }

        return {
            ok: true,
            allowed: true,
            reasonCode: "CAP_PARENT_VALID",
            decisionId: crypto.randomUUID(),
            stage: "parent-load",
            grant
        };
    }
    /* ----------------------------- DELEGASI ----------------------------- */

    async delegate(parentCapabilityId, requested, actor = "delegator") {

        const parent = await this.loadGrant(parentCapabilityId);
        if (!parent.ok) return parent;                    // sudah Decision

        const result = attenuateGrant(parent.grant, requested);
        if (!result.ok) {
            await this.store.appendEvent(this.ev(
                "CAPABILITY_DELEGATION_DENIED", parentCapabilityId, actor,
                { violations: result.violations }));
            return {
                allowed: false,
                reasonCode: result.violations[0].reasonCode,
                violations: result.violations,
                decisionId: crypto.randomUUID(),
                stage: "attenuation", grant: null
            };
        }

        const childGen = await this.store.getGeneration(result.grant.subject);
        result.grant.generation = childGen;

        const grant = M.buildGrant(result.grant);

        await this.store.upsertCapability(grant.capabilityId,
            grant.status, grant.generation, JSON.stringify(grant));
        await this.store.appendEvent(this.ev("CAPABILITY_DELEGATED",
            grant.capabilityId, actor,
            { parentCapabilityId }));

        return { allowed: true, reasonCode: "DELEGATED",
                 decisionId: crypto.randomUUID(),
                 capabilityId: grant.capabilityId, grant };

    }

    /* ------------------------------ LIFECYCLE ---------------------------- */

    async suspend(id, actor = "owner") {
        return this.transition(id, "SUSPENDED", "CAPABILITY_SUSPENDED", actor);
    }
    async resume(id, actor = "owner") {
        return this.transition(id, "ACTIVE", "CAPABILITY_RESUMED", actor);
    }
    async revoke(id, actor = "owner") {
        return this.transition(id, "REVOKED", "CAPABILITY_REVOKED", actor);
    }

    async transition(id, toStatus, eventType, actor) {

        const cap = await this.store.getCapability(id);
        if (!cap) return { ok: false, reasonCode: "CAP_NOT_FOUND" };

        if (!M.canTransition(cap.status, toStatus)) {
            // REVOKED/EXPIRED/EXHAUSTED tidak boleh hidup lagi (Â§F).
            return { ok: false,
                     reasonCode: toStatus === "ACTIVE"
                         ? (cap.status === "REVOKED" ? "CAP_REVOKED"
                                                     : "CAP_INACTIVE")
                         : "CAP_INACTIVE",
                     detail: `transisi ${cap.status}->${toStatus} tidak sah` };
        }

        const payload = JSON.parse(JSON.stringify(cap.payload));
        payload.status = toStatus;

        await this.store.upsertCapability(id, toStatus, cap.generation,
            JSON.stringify(payload));
        await this.store.appendEvent(this.ev(eventType, id, actor,
            { from: cap.status, to: toStatus }));

        return { ok: true, status: toStatus };
    }

    /* ------------------------------- BUDGET ------------------------------ */

    /** Atomik (Â§H): status/generation/expiry direvalidasi DALAM transaksi. */
    async consumeExecution(capabilityId, meta = {}) {

        const cap = await this.store.getCapability(capabilityId);
        if (!cap) return { allowed: false, reasonCode: "CAP_NOT_FOUND" };

        const payload = cap.payload;

        const curGen = await this.store.getGeneration(payload.subject);
        if (curGen !== cap.generation)
            return { allowed: false, reasonCode: "CAP_GENERATION_STALE" };
        if (cap.status === "SUSPENDED")
            return { allowed: false, reasonCode: "CAP_INACTIVE" };
        if (cap.status === "REVOKED")
            return { allowed: false, reasonCode: "CAP_REVOKED" };
        if (cap.status === "EXHAUSTED")
            return { allowed: false, reasonCode: "CAP_EXHAUSTED" };
        if (cap.status === "EXPIRED")
            return { allowed: false, reasonCode: "CAP_EXPIRED" };
        const nowMs = this.clock.nowMs();
        if (payload.expiresAt && nowMs > Date.parse(payload.expiresAt))
            return { allowed: false, reasonCode: "CAP_EXPIRED" };

        const result = await this.store.consumeExecution({
            capabilityId,
            maxExecutions: payload.maxExecutions,
            at: this.nowIso(), meta
        });
        if (!result.ok)
            return { allowed: false, reasonCode: "CAP_EXHAUSTED",
                     used: result.used };

        await this.store.appendEvent(this.ev("CAPABILITY_CONSUMED",
            capabilityId, "registry",
            { used: result.used, consumptionId: result.consumptionId }));

        let exhausted = result.exhausted;
        if (exhausted) {
            payload.status = "EXHAUSTED";
            await this.store.upsertCapability(capabilityId, "EXHAUSTED",
                cap.generation, JSON.stringify(payload));
            await this.store.appendEvent(this.ev("CAPABILITY_EXHAUSTED",
                capabilityId, "registry", { maxExecutions: payload.maxExecutions }));
        }

        return { allowed: true, used: result.used,
                 remaining: payload.maxExecutions - result.used, exhausted };
    }

    /* ----------------------------- AUTHORIZE ----------------------------- */

    async authorize({ capabilityId, action, scope = [], purpose = null,
                      identity = {}, nowMs = null }) {

        const atMs = (nowMs ?? this.clock.nowMs());

        try {
            var capId = canonicalCapabilityId(capabilityId);
            var reqAction = String(action ?? "").trim().toLowerCase();
            var reqScope = canonicalTokenList(scope, "scope");
        } catch (error) {
            return denyStage("CAP_MALFORMED", error.message, "normalize");
        }

        const cap = await this.store.getCapability(capId);
        if (!cap) return denyStage("CAP_NOT_FOUND", null, "lookup");

        const g = cap.payload;

        const curGen = await this.store.getGeneration(g.subject);
        if (curGen !== cap.generation)
            return denyStage("CAP_GENERATION_STALE",
                `gen ${cap.generation} != current ${curGen}`, "generation");

        if (cap.status === "SUSPENDED")
            return denyStage("CAP_INACTIVE", null, "status");
        if (cap.status === "REVOKED")
            return denyStage("CAP_REVOKED", null, "status");
        if (cap.status === "EXHAUSTED")
            return denyStage("CAP_BUDGET_EXHAUSTED", null, "budget");

        if (g.notBefore && atMs < Date.parse(g.notBefore))
            return denyStage("CAP_INACTIVE", g.notBefore, "notBefore");
        if (g.expiresAt && atMs > Date.parse(g.expiresAt))
            return denyStage("CAP_EXPIRED", g.expiresAt, "expiry");

        if (!g.actions.includes(reqAction))
            return denyStage("CAP_ACTION_DENIED", reqAction, "action");

        for (const token of reqScope) {
            if (g.scope.length && !g.scope.includes(token)) {
                return denyStage("CAP_SCOPE_MISMATCH", token, "scope");
            }
        }

        if (purpose !== null && purpose !== undefined) {
            const p = String(purpose).trim().toLowerCase();
            if (g.allowedPurposes.length && !g.allowedPurposes.includes(p)) {
                return denyStage("CAP_PURPOSE_MISMATCH", p, "purpose");
            }
        } else if (g.allowedPurposes.length) {
            return denyStage("CAP_PURPOSE_MISMATCH", "(kosong)", "purpose");
        }

        const ib = g.identityBinding;
        if (ib) {
            const channel = String(identity.channel ?? "").toLowerCase();
            if (ib.channels?.length && !ib.channels.includes(channel))
                return denyStage("CAP_IDENTITY_MISMATCH", "channel", "identity");
            if (ib.sessionIds?.length &&
                !ib.sessionIds.includes(String(identity.sessionId ?? "")))
                return denyStage("CAP_IDENTITY_MISMATCH", "sessionId", "identity");
            if (ib.principals?.length &&
                !ib.principals.includes(String(identity.principal ?? "")))
                return denyStage("CAP_IDENTITY_MISMATCH", "principal", "identity");
        }

        if (typeof g.maxExecutions === "number") {
            const used = await this.store.countConsumption(capId);
            if (used >= g.maxExecutions)
                return denyStage("CAP_BUDGET_EXHAUSTED",
                    `${used}/${g.maxExecutions}`, "budget");
        }

        const restrictions = restoreCanonicalRestrictionSet(g.restrictions);

        const decisionId = crypto.randomUUID();
        const snapshot = deepFreeze({
            decisionId,
            capabilityId: capId,
            subject: g.subject,
            kind: g.kind,
            actions: [...g.actions],
            scope: [...reqScope],
            allowedPurposes: [...g.allowedPurposes],
            restrictions,
            purpose: purpose ? String(purpose).trim().toLowerCase() : null,
            identityBinding: g.identityBinding,
            maxExecutions: g.maxExecutions,
            expiresAt: g.expiresAt,
            generation: cap.generation,
            rootCapabilityId: g.rootCapabilityId,
            parentCapabilityId: g.parentCapabilityId,
            ratificationId: g.ratificationId,
            issuedAt: g.issuedAt,
            authorizedAt: new Date(atMs).toISOString()
        });

        await this.store.appendEvent(this.ev("CAPABILITY_AUTHORIZED",
            capId, "registry", { decisionId, action: reqAction }));

        return { allowed: true, reasonCode: "AUTHORIZED",
                 decisionId, capabilityId: capId, stage: "authorized",
                 snapshot };

        function denyStage(reasonCode, detail, stage) {
            return { allowed: false, reasonCode, detail: detail ?? null,
                     decisionId: crypto.randomUUID(), stage,
                     snapshot: null };
        }
    }

    /** Revalidasi pra-eksekusi utk material action (Â§K): revoke menutup. */
    async revalidateExecution(snapshot) {
        if (!snapshot || !Object.isFrozen(snapshot)) {
            return { allowed: false, reasonCode: "CAP_MALFORMED",
                     detail: "snapshot tidak sah / tidak frozen" };
        }
        const probe = await this.authorize({
            capabilityId: snapshot.capabilityId,
            action: snapshot.actions[0] ?? "use",
            scope: snapshot.scope,
            purpose: snapshot.purpose,
            identity: {}
        });
        return probe.allowed
            ? { allowed: true, decisionId: probe.decisionId }
            : { allowed: false, reasonCode: probe.reasonCode,
                detail: "revalidasi pasca-otorisasi gagal" };
    }

    /* --------------------- EVOLUTION / EXPANSION (Â§D/N) ------------------ */

    /** ACC/model boleh MENGAJUKAN â€” hasil = DRAFT, nol otoritas (Â§N). */
    async proposeEvolution(proposalInput, actor = "acc") {

        const proposal = M.buildEvolutionProposal({
            ...proposalInput, at: this.nowIso() });

        await this.store.upsertProposal(proposal);
        await this.store.appendEvent(this.ev(
            proposal.kind === "authority_expansion"
                ? "AUTHORITY_EXPANSION_REQUESTED"
                : "EVOLUTION_PROPOSED",
            null, actor,
            { proposalId: proposal.proposalId,
              revision: proposal.revision,
              digest: proposal.digest,
              createdBy: proposal.createdBy }));

        return proposal;
    }

    /** Revisi material -> digest baru; ratifikasi lama otomatis stale. */
    async reviseEvolution(proposalId, patchFields, actor = "system") {

        const prev = await this.store.getProposal(proposalId);
        if (!prev) return null;

        const mergedCore = stripLifecycle(prev);
        for (const [k, v] of Object.entries(patchFields)) {
            if (k in prev) mergedCore[k] =
                v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v;
        }

        const revised = Object.freeze({
            ...prev, ...patchFields,
            revision: (prev.revision ?? 1) + 1,
            digest: M.evolutionDigest(mergedCore),
            status: patchFields.status ?? prev.status
        });

        await this.store.upsertProposal(revised);
        await this.store.appendEvent(this.ev("EVOLUTION_REVISED",
            null, actor,
            { proposalId, revision: revised.revision, digest: revised.digest }));

        return revised;

        function stripLifecycle(p) {
            const c = JSON.parse(JSON.stringify(p));
            delete c.revision; delete c.digest; delete c.status;
            return c;
        }
    }

    /** Owner decision â€” mem-bind digest revisi SAAT RATIFIKASI (Â§E). */
    async ratify({ ratificationId, proposalId, ownerIdentity, decision,
                   expiryAt = null, supersedes = null }) {

        const proposal = await this.store.getProposal(proposalId);
        if (!proposal) {
            return { applied: false, reasonCode: "CAP_NOT_FOUND",
                     detail: "proposal tidak ditemukan" };
        }

        const r = M.buildRatification({
            ratificationId, proposalId, ownerIdentity, decision,
            approvedAuthority: null, expiryAt,
            at: this.nowIso(), supersedes
        });
        const bound = Object.freeze({
            ...r, proposalDigest: proposal.digest
        });

        await this.store.upsertRatification(bound);
        await this.store.appendEvent(this.ev(
            decision === "APPROVED" ? "OWNER_RATIFIED" : "OWNER_REJECTED",
            null, ownerIdentity,
            { ratificationId, proposalId, digest: bound.proposalDigest }));

        return { applied: true, ratification: bound };

    }

    /** Ambil ratifikasi lengkap (payload + digest binding). */
    async getRatification(rid) {
        return this.store.getRatification(rid);
    }

}

module.exports = { AuthorityRegistry };

