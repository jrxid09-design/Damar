/**
 * AUTHORITY REGISTRY V1 — satu pintu lifecycle + keputusan otoritas.
 *
 *   - REQUEST != GRANT ; PROPOSAL != AUTHORITY
 *   - Delegasi hanya via attenuateGrant (subset law, no-widening)
 *   - Root grant baru HANYA dari OwnerRatification APPROVED yang ter-bind
 *     ke digest+revisi proposal saat ratifikasi; grant dibangun eksklusif
 *     dari ratification.approvedAuthority; satu ratifikasi = satu grant
 *   - CapabilityId dikanonikalisasi di SETIAP entry point publik
 *   - consumeExecution atomik anti-TOCTOU ; generation bump = bulk revoke
 */

const crypto = require("node:crypto");
const M = require("./model");
const { attenuateGrant } = require("./delegation");
const { evaluateAuthorityReadOnly } = require("./evaluate");
const { canonicalCapabilityId, canonicalTokenList,
        canonicalRestrictionSet,
        restoreCanonicalRestrictionSet,
        canonicalJson, sha256,
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

    /** Kanonikalisasi CapabilityId utk semua entry point (L-D2). */
    canonId(capabilityId) {
        return canonicalCapabilityId(capabilityId);
    }

    /* ------------------------ GENERATION (§G) --------------------------- */

    async revokeSubjectGeneration(subject, actor = "owner") {
        const g = await this.store.bumpGeneration(subject, this.nowIso());
        await this.store.appendEvent(this.ev(
            "SUBJECT_GENERATION_BUMPED", null, actor,
            { subject, newGeneration: g }));
        return g;
    }

    /* --------------------- RATIFIED ROOT GRANT (§E) ---------------------- */

    /**
     * SATU-SATUNYA jalur authority > previous. Grant dibangun EKSKLUSIF
     * dari ratification.approvedAuthority (immutable, di-bind ke digest +
     * revisi proposal SAAT RATIFIKASI). requestedAuthority (bila disertakan)
     * hanya assertion kesetaraan — tidak pernah sumber otoritas.
     * Satu ratifikasi APPROVED = Paling banyak SATU root grant; replay
     * ditolak CAP_RATIFICATION_CONSUMED.
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
        if (rat.proposalId !== proposalId) {
            return deny("CAP_MALFORMED", "ratifikasi milik proposal lain");
        }

        // Binding wajib: digest + revisi proposal saat ratifikasi.
        const revisionNow = proposal.revision ?? 1;
        if (rat.proposalDigest !== proposal.digest ||
            (rat.proposalRevision ?? 1) !== revisionNow) {
            return deny("CAP_RATIFICATION_REQUIRED",
                "digest/revisi proposal berubah setelah ratifikasi (stale)");
        }

        const expiryMs = rat.expiryAt ? Date.parse(rat.expiryAt) : null;
        if (rat.expiryAt && (Number.isNaN(expiryMs) ||
                             expiryMs < this.clock.nowMs())) {
            return deny("CAP_RATIFICATION_REQUIRED", "ratifikasi kedaluwarsa");
        }

        // Sumber otoritas TUNGGAL: approvedAuthority yang diratifikasi.
        const approved = rat.approvedAuthority;
        if (!approved || typeof approved !== "object" ||
            Array.isArray(approved)) {
            return deny("CAP_MALFORMED",
                "ratifikasi tidak membawa approvedAuthority");
        }

        let approvedDigest;
        try {
            approvedDigest =
                sha256(canonicalJson(JSON.parse(JSON.stringify(approved))));
        } catch (error) {
            return deny("CAP_MALFORMED",
                "approvedAuthority tidak bisa dikanonikalisasi: " +
                error.message);
        }
        if (rat.approvedAuthorityDigest !== approvedDigest) {
            return deny("CAP_MALFORMED",
                "approvedAuthority digest mismatch (tamper)");
        }

        // requestedAuthority hanya boleh sebagai equality assertion.
        if (requestedAuthority !== null && requestedAuthority !== undefined) {
            let requestedDigest;
            try {
                requestedDigest = sha256(canonicalJson(
                    JSON.parse(JSON.stringify(requestedAuthority))));
            } catch (error) {
                return deny("CAP_MALFORMED",
                    "requestedAuthority tidak bisa dikanonikalisasi: " +
                    error.message);
            }
            if (requestedDigest !== approvedDigest) {
                return deny("CAP_MALFORMED",
                    "requestedAuthority != approvedAuthority " +
                    "yang diratifikasi owner");
            }
        }

        if (!approved.capabilityId || !approved.subject ||
            !Array.isArray(approved.actions) || !approved.actions.length) {
            return deny("CAP_MALFORMED", "approvedAuthority tidak lengkap");
        }

        const subjectGen =
            await this.store.getGeneration(String(approved.subject));

        const grant = M.buildGrant({
            capabilityId: approved.capabilityId,
            kind: "root",
            subject: approved.subject,
            issuer: "owner-ratification:" + ratificationId.slice(0, 60),
            actions: approved.actions,
            scope: approved.scope ?? [],
            allowedPurposes: approved.allowedPurposes ?? [],
            restrictions: approved.restrictions ?? null,
            maxExecutions: approved.maxExecutions ?? null,
            issuedAt: this.nowIso(),
            notBefore: approved.notBefore ?? null,
            expiresAt: approved.expiresAt ?? rat.expiryAt ?? null,
            generation: subjectGen,
            delegationDepth: 0,
            remainingDelegationDepth:
                Number.isInteger(approved.remainingDelegationDepth)
                    ? approved.remainingDelegationDepth : 2,
            purpose: approved.purpose ?? null,
            identityBinding: approved.identityBinding ?? null,
            ratificationId,
            extra: { proposalDigest: proposal.digest,
                     proposalRevision: revisionNow }
        });

        // ATOMIK: verifikasi ulang ratifikasi + tulis capability +
        // konsumsi one-shot + event dalam satu transaksi store.
        const result = await this.store.issueRootGrantAtomic({
            capabilityId: grant.capabilityId,
            status: grant.status,
            generation: grant.generation,
            payload: JSON.stringify(grant),
            ratificationId,
            expectProposalDigest: proposal.digest,
            expectProposalRevision: revisionNow,
            expectApprovedAuthorityDigest: approvedDigest,
            events: [this.ev("CAPABILITY_GRANTED",
                grant.capabilityId, actor,
                { kind: "root", ratificationId,
                  proposalDigest: proposal.digest,
                  proposalRevision: revisionNow })]
        });

        if (!result.ok) {
            return deny(result.reasonCode, result.detail);
        }

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

        const denyDecision = (reasonCode, detail, stage, violations = []) => ({
            allowed: false, reasonCode, detail: detail ?? null, violations,
            decisionId: crypto.randomUUID(), stage, grant: null });

        // Canonicalize id parent SEBELUM lookup apa pun (L-D2).
        let parentId;
        try {
            parentId = canonicalCapabilityId(parentCapabilityId);
        } catch (error) {
            return denyDecision("CAP_MALFORMED", error.message, "normalize");
        }

        const parent = await this.loadGrant(parentId);
        if (!parent.ok) return parent;                    // sudah Decision

        // Input wajib object; selain itu fail-closed Decision.
        if (!requested || typeof requested !== "object" ||
            Array.isArray(requested)) {
            return denyDecision("CAP_MALFORMED",
                "requested delegation tidak sah", "normalize");
        }

        try {

            const result = attenuateGrant(parent.grant, requested);
            if (!result.ok) {
                await this.store.appendEvent(this.ev(
                    "CAPABILITY_DELEGATION_DENIED", parentId, actor,
                    { violations: result.violations }));
                return {
                    allowed: false,
                    reasonCode: result.violations[0].reasonCode,
                    detail: null,
                    violations: result.violations,
                    decisionId: crypto.randomUUID(),
                    stage: "attenuation", grant: null
                };
            }

            const childGen =
                await this.store.getGeneration(result.grant.subject);
            result.grant.generation = childGen;

            const grant = M.buildGrant(result.grant);

            // ATOMIK: revalidasi parent + reservasi budget delegable +
            // tulis child + event dalam satu transaksi store.
            const commit = await this.store.delegateGrantAtomic({
                childCapabilityId: grant.capabilityId,
                childStatus: grant.status,
                childGeneration: grant.generation,
                childPayload: JSON.stringify(grant),
                parentCapabilityId: parentId,
                expectParentGeneration: parent.grant.generation,
                reserveAmount: typeof grant.maxExecutions === "number"
                    ? grant.maxExecutions : null,
                events: [this.ev("CAPABILITY_DELEGATED",
                    grant.capabilityId, actor,
                    { parentCapabilityId: parentId,
                      reservedBudget:
                          typeof grant.maxExecutions === "number"
                              ? grant.maxExecutions : null })]
            });

            if (!commit.ok) {
                return denyDecision(commit.reasonCode, commit.detail,
                    "commit");
            }

            return { allowed: true, reasonCode: "DELEGATED",
                     decisionId: crypto.randomUUID(),
                     capabilityId: grant.capabilityId, grant };

        } catch (error) {
            // Input malformed -> fail-closed Decision.
            // Kegagalan store/injected (rollback tx) TETAP dilempar:
            // pemanggil wajib tahu bahwa terjadi kegagalan persistensi,
            // bukan sekadar penolakan otoritas.
            if (error && typeof error.reasonCode === "string") {
                return denyDecision(error.reasonCode,
                    error.message, "attenuation");
            }
            throw error;
        }
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

        let capId;
        try {
            capId = canonicalCapabilityId(id);
        } catch (error) {
            return { ok: false, reasonCode: "CAP_MALFORMED",
                     detail: error.message };
        }

        const cap = await this.store.getCapability(capId);
        if (!cap) return { ok: false, reasonCode: "CAP_NOT_FOUND" };

        if (!M.canTransition(cap.status, toStatus)) {
            // REVOKED/EXPIRED/EXHAUSTED tidak boleh hidup lagi (§F).
            return { ok: false,
                     reasonCode: toStatus === "ACTIVE"
                         ? (cap.status === "REVOKED" ? "CAP_REVOKED"
                                                     : "CAP_INACTIVE")
                         : "CAP_INACTIVE",
                     detail: `transisi ${cap.status}->${toStatus} tidak sah` };
        }

        const payload = JSON.parse(JSON.stringify(cap.payload));
        payload.status = toStatus;

        await this.store.upsertCapability(capId, toStatus, cap.generation,
            JSON.stringify(payload));
        await this.store.appendEvent(this.ev(eventType, capId, actor,
            { from: cap.status, to: toStatus }));

        return { ok: true, status: toStatus };
    }

    /* ------------------------------- BUDGET ------------------------------ */

    /**
     * Atomik anti-TOCTOU (§H): seluruh revalidasi (exists/ACTIVE/generation/
     * notBefore/expiry/budget) dieksekusi DI DALAM operasi atomik store
     * yang sama dengan penulisan ledger — revoke yang interleaved setelah
     * precheck mana pun tetap menutup konsumsi.
     */
    async consumeExecution(capabilityId, meta = {}) {

        let capId;
        try {
            capId = canonicalCapabilityId(capabilityId);
        } catch (error) {
            return { allowed: false, reasonCode: "CAP_MALFORMED",
                     detail: error.message };
        }

        const result = await this.store.consumeExecutionAtomic({
            capabilityId: capId,
            at: this.nowIso(), meta, nowMs: this.clock.nowMs()
        });

        if (!result.ok) {
            return { allowed: false, reasonCode: result.reasonCode,
                     detail: result.detail ?? null,
                     used: result.used };
        }

        const max = result.maxExecutions;

        return { allowed: true, used: result.used,
                 remaining: typeof max === "number"
                     ? max - result.used : null,
                 exhausted: result.exhausted };
    }

    /* ----------------------------- AUTHORIZE ----------------------------- */

    async authorize({ capabilityId, action, scope = [], purpose = null,
                      identity = {}, nowMs = null }) {

        const atMs = (nowMs ?? this.clock.nowMs());

        // Single canonical read-only evaluation (shared with Wave-4 Lane 2).
        const result = await evaluateAuthorityReadOnly(this.store, {
            capabilityId, action, scope, purpose, identity, nowMs: atMs
        });

        if (result.allowed !== true) {
            return {
                allowed: false,
                reasonCode: result.reasonCode,
                detail: result.detail ?? null,
                decisionId: crypto.randomUUID(),
                stage: stageOf(result.reasonCode),
                snapshot: null
            };
        }

        const cap = await this.store.getCapability(canonicalCapabilityId(capabilityId));
        const g = cap.payload;
        const capId = canonicalCapabilityId(capabilityId);
        const reqAction = String(action ?? "").trim().toLowerCase();
        const reqScope = canonicalTokenList(scope, "scope");

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

        function stageOf(reasonCode) {
            switch (reasonCode) {
                case "CAP_MALFORMED": return "normalize";
                case "CAP_NOT_FOUND": return "lookup";
                case "CAP_GENERATION_STALE": return "generation";
                case "CAP_INACTIVE": return "status";
                case "CAP_REVOKED": return "status";
                case "CAP_BUDGET_EXHAUSTED": return "budget";
                case "CAP_EXPIRED": return "expiry";
                case "CAP_ACTION_DENIED": return "action";
                case "CAP_SCOPE_MISMATCH": return "scope";
                case "CAP_PURPOSE_MISMATCH": return "purpose";
                case "CAP_IDENTITY_MISMATCH": return "identity";
                default: return "authorized";
            }
        }
    }

    /** Revalidasi pra-eksekusi utk material action (§K): revoke menutup. */
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

    /* --------------------- EVOLUTION / EXPANSION (§D/N) ------------------ */

    /** ACC/model boleh MENGAJUKAN — hasil = DRAFT, nol otoritas (§N). */
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

    /**
     * Owner decision (§E). Ratifikasi mengikat SECARA IMMUTABLE:
     *   proposalId + revisi + digest proposal + approvedAuthority
     *   (+ digest kanonik approvedAuthority).
     * Cognition/proposal TIDAK BISA menentukan authority yang berbeda
     * dari yang diratifikasi owner.
     */
    async ratify({ ratificationId, proposalId, ownerIdentity, decision,
                   expiryAt = null, supersedes = null }) {

        const fail = (reasonCode, detail) => ({
            applied: false, reasonCode, detail });

        const proposal = await this.store.getProposal(proposalId);
        if (!proposal) {
            return fail("CAP_NOT_FOUND", "proposal tidak ditemukan");
        }

        // Bind EXACT authority dari revisi proposal yang diratifikasi.
        let approvedAuthority = null;
        let approvedAuthorityDigest = null;

        if (proposal.requestedAuthority) {
            approvedAuthority =
                JSON.parse(JSON.stringify(proposal.requestedAuthority));

            // Validasi struktural fail-closed SEBELUM binding.
            try {
                canonicalCapabilityId(approvedAuthority.capabilityId);
                if (!approvedAuthority.subject ||
                    typeof approvedAuthority.subject !== "string") {
                    throw new Error("subject wajib");
                }
                const acts = canonicalTokenList(
                    approvedAuthority.actions ?? [], "actions");
                if (!acts.length) throw new Error("actions wajib non-kosong");
                if (approvedAuthority.maxExecutions !== undefined &&
                    approvedAuthority.maxExecutions !== null) {
                    const n = Number(approvedAuthority.maxExecutions);
                    if (!Number.isInteger(n) || n <= 0) {
                        throw new Error("maxExecutions harus integer > 0");
                    }
                }
            } catch (error) {
                return fail("CAP_MALFORMED",
                    "requestedAuthority pada proposal tidak sah: " +
                    error.message);
            }

            approvedAuthorityDigest =
                sha256(canonicalJson(approvedAuthority));
        }

        const r = M.buildRatification({
            ratificationId, proposalId, ownerIdentity, decision,
            approvedAuthority, expiryAt,
            at: this.nowIso(), supersedes
        });

        const bound = Object.freeze({
            ...r,
            proposalDigest: proposal.digest,
            proposalRevision: proposal.revision ?? 1,
            approvedAuthority,
            approvedAuthorityDigest
        });

        await this.store.upsertRatification(bound);
        await this.store.appendEvent(this.ev(
            decision === "APPROVED" ? "OWNER_RATIFIED" : "OWNER_REJECTED",
            null, ownerIdentity,
            { ratificationId, proposalId,
              proposalRevision: bound.proposalRevision,
              digest: bound.proposalDigest }));

        return { applied: true, ratification: bound };

    }

    /** Ambil ratifikasi lengkap (payload + digest binding). */
    async getRatification(rid) {
        return this.store.getRatification(rid);
    }

}

module.exports = { AuthorityRegistry };
