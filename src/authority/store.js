/**
 * AUTHORITY STORE — memory & sqlite backends, semantik identik.
 *
 * KONTRAK ATOMIK (§H):
 *   - issueRootGrantAtomic()  : verifikasi ratifikasi (APPROVED, digest,
 *     revision, belum dikonsumsi) + tulis capability + konsumsi ratifikasi
 *     (one-shot) + append event dalam SATU unit.
 *   - delegateGrantAtomic()   : revalidasi parent + reservasi budget
 *     delegable parent + tulis child + append event dalam SATU unit.
 *   - consumeExecutionAtomic(): revalidasi penuh (exists/ACTIVE/generation/
 *     notBefore/expiry/budget) DI DALAM operasi atomik yang sama dengan
 *     penulisan ledger (anti-TOCTOU), lalu transisi EXHAUSTED + event.
 *
 * Kegagalan di langkah mana pun = ROLLBACK; tidak ada state otoritas
 * yang hidup setengah. Backend memory memakai snapshot-rollback sehingga
 * semantiknya identik dengan SQLite BEGIN IMMEDIATE ... COMMIT/ROLLBACK.
 */

const crypto = require("node:crypto");
const uuid = () => crypto.randomUUID();

function normalizeCapabilityPayload(payload) {
    if (typeof payload === "string") {
        return JSON.parse(payload);
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return JSON.parse(JSON.stringify(payload));
    }
    throw new TypeError("Capability payload harus JSON object atau JSON string");
}

function cloneCapabilityPayload(payload) {
    return JSON.parse(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* VALIDATOR BERSAMA — dipakai kedua backend agar kontrak identik.      */
/* ------------------------------------------------------------------ */

const TERMINAL_NO_RESURRECT = Object.freeze({
    REVOKED: "CAP_REVOKED",
    EXPIRED: "CAP_EXPIRED",
    EXHAUSTED: "CAP_EXHAUSTED"
});

/**
 * Evaluasi konsumsi eksekusi (pure). Dipanggil DI DALAM bagian atomik
 * oleh kedua backend. maxExecutions null/undefined = unlimited.
 */
function evaluateConsumption({ capEntry, used, currentGeneration, nowMs }) {
    if (!capEntry) {
        return { ok: false, reasonCode: "CAP_NOT_FOUND" };
    }
    if (Number.isFinite(currentGeneration) &&
        capEntry.generation !== currentGeneration) {
        return { ok: false, reasonCode: "CAP_GENERATION_STALE" };
    }
    switch (capEntry.status) {
        case "SUSPENDED": return { ok: false, reasonCode: "CAP_INACTIVE" };
        case "REVOKED":   return { ok: false, reasonCode: "CAP_REVOKED" };
        case "EXHAUSTED": return { ok: false, reasonCode: "CAP_EXHAUSTED" };
        case "EXPIRED":   return { ok: false, reasonCode: "CAP_EXPIRED" };
        case "ACTIVE": break;
        default: return { ok: false, reasonCode: "CAP_INACTIVE" };
    }

    const payload = capEntry.payload ?? {};
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();

    if (payload.notBefore) {
        const nb = Date.parse(payload.notBefore);
        if (Number.isNaN(nb)) {
            return { ok: false, reasonCode: "CAP_MALFORMED",
                     detail: "notBefore bukan waktu valid" };
        }
        if (now < nb) return { ok: false, reasonCode: "CAP_INACTIVE" };
    }
    if (payload.expiresAt) {
        const ex = Date.parse(payload.expiresAt);
        if (Number.isNaN(ex)) {
            return { ok: false, reasonCode: "CAP_MALFORMED",
                     detail: "expiresAt bukan waktu valid" };
        }
        if (now > ex) return { ok: false, reasonCode: "CAP_EXPIRED" };
    }

    const max = payload.maxExecutions;
    if (typeof max === "number" && used >= max) {
        return { ok: false, reasonCode: "CAP_EXHAUSTED", used };
    }
    return { ok: true };
}

/** Terminal state tidak boleh ditimpa menjadi hidup lagi (§F). */
function terminalResurrectionConflict(existingStatus) {
    if (existingStatus in TERMINAL_NO_RESURRECT) {
        return {
            ok: false,
            reasonCode: TERMINAL_NO_RESURRECT[existingStatus],
            detail:
                `capability_id sudah terminal (${existingStatus}); ` +
                "reissue wajib capabilityId + ratifikasi owner yang baru"
        };
    }
    if (existingStatus) {
        return {
            ok: false,
            reasonCode: "CAP_MALFORMED",
            detail: `capability_id sudah terpakai (${existingStatus})`
        };
    }
    return null;
}

function consumptionEvent(capabilityId, at, used, consumptionId) {
    return {
        eventId: uuid(), type: "CAPABILITY_CONSUMED",
        capability_id: capabilityId, actor: "registry", at,
        payload: { used, consumptionId }
    };
}

/* ------------------------------------------------------------------ */
/* MEMORY BACKEND                                                       */
/* ------------------------------------------------------------------ */

function createMemoryAuthorityStore() {
    const caps = new Map();      // id -> {status,payload}
    const events = [];
    const consumption = [];      // {consumption_id,capability_id,at}
    const generations = new Map();
    const ratifications = new Map();
    const proposals = new Map();
    const delegationReservations = new Map(); // childId -> {parent,amount,at}

    const api = {
        backend: "memory",

        async upsertCapability(id, status, generation, payload) {
            caps.set(id, {
                status,
                generation,
                payload: normalizeCapabilityPayload(payload)
            });
        },
        async getCapability(id) {
            const cap = caps.get(id);
            if (!cap) return null;
            return {
                status: cap.status,
                generation: cap.generation,
                payload: cloneCapabilityPayload(cap.payload)
            };
        },
        async listCapabilitiesBySubject(subject) {
            return [...caps.entries()]
                .filter(([, v]) => v.payload?.subject === subject)
                .map(([capability_id, v]) => ({ capability_id, ...v }));
        },

        async appendEvent(e) {
            events.push(Object.freeze({ ...e }));
        },
        async listEvents(capabilityId) {
            return events.filter(e => e.capability_id === capabilityId);
        },

        async countConsumption(capabilityId) {
            return consumption.filter(c => c.capability_id === capabilityId)
                .length;
        },

        async getGeneration(subject) {
            return generations.get(subject) ?? 0;
        },
        async bumpGeneration(subject, at) {
            const g = (generations.get(subject) ?? 0) + 1;
            generations.set(subject, g);
            void at;
            return g;
        },

        async upsertRatification(r) {
            ratifications.set(r.ratificationId,
                JSON.parse(JSON.stringify(r)));
        },
        async getRatification(rid) {
            const r = ratifications.get(rid);
            return r ? JSON.parse(JSON.stringify(r)) : null;
        },

        async upsertProposal(p) { proposals.set(p.proposalId, p); },
        async getProposal(pid) { return proposals.get(pid) ?? null; },

        async getDelegationReservations(parentCapabilityId) {
            return [...delegationReservations.entries()]
                .filter(([, v]) => v.parent === parentCapabilityId)
                .map(([child, v]) => ({ childCapabilityId: child, ...v }));
        },

        /**
         * ATOMIK: ratifikasi one-shot + grant + event.
         * Memory atomic-by-construction (sinkron antara await);
         * snapshot rollback bila langkah mana pun gagal.
         */
        async issueRootGrantAtomic({ capabilityId, status, generation,
                                     payload, ratificationId,
                                     expectProposalDigest,
                                     expectProposalRevision,
                                     expectApprovedAuthorityDigest,
                                     events }) {
            const prevCap = caps.get(capabilityId) ?? null;
            const prevRat = ratifications.get(ratificationId) ?? null;
            const eventsMark = events.length;

            try {
                const r = prevRat;
                if (!r || r.decision !== "APPROVED") {
                    return { ok: false,
                             reasonCode: "CAP_RATIFICATION_REQUIRED",
                             detail: "ratifikasi APPROVED tidak ditemukan" };
                }
                if (r.consumedAt) {
                    return { ok: false,
                             reasonCode: "CAP_RATIFICATION_CONSUMED",
                             detail: "ratifikasi sudah dikonsumsi " +
                                     "(satu APPROVED = satu root grant)" };
                }
                if (r.proposalDigest !== expectProposalDigest ||
                    (r.proposalRevision ?? 1) !==
                        (expectProposalRevision ?? 1) ||
                    r.approvedAuthorityDigest !==
                        expectApprovedAuthorityDigest) {
                    return { ok: false,
                             reasonCode: "CAP_RATIFICATION_REQUIRED",
                             detail: "binding ratifikasi tidak cocok " +
                                     "(stale/tamper)" };
                }
                const conflict =
                    terminalResurrectionConflict(prevCap?.status ?? null);
                if (conflict) return conflict;

                caps.set(capabilityId, {
                    status,
                    generation,
                    payload: normalizeCapabilityPayload(payload)
                });
                ratifications.set(ratificationId, {
                    ...JSON.parse(JSON.stringify(r)),
                    consumedAt: new Date().toISOString(),
                    consumedByCapabilityId: capabilityId
                });
                for (const e of events ?? []) await api.appendEvent(e);
                return { ok: true };
            }
            catch (error) {
                // Rollback snapshot agar tidak ada state setengah jadi.
                if (prevCap) caps.set(capabilityId, prevCap);
                else caps.delete(capabilityId);
                if (prevRat) ratifications.set(ratificationId, prevRat);
                else ratifications.delete(ratificationId);
                events.length = eventsMark;
                throw error;
            }
        },

        /**
         * ATOMIK: revalidasi parent + reservasi budget delegable + tulis
         * child + event. Total budget anak TIDAK bisa melebihi budget
         * parent (anti sibling-amplification).
         */
        async delegateGrantAtomic({ childCapabilityId, childStatus,
                                    childGeneration, childPayload,
                                    parentCapabilityId,
                                    expectParentGeneration,
                                    reserveAmount, events }) {
            const prevChild = caps.get(childCapabilityId) ?? null;
            const eventsMark = events.length;
            try {
                const parent = caps.get(parentCapabilityId) ?? null;
                if (!parent) {
                    return { ok: false, reasonCode: "CAP_NOT_FOUND",
                             detail: "parent hilang saat commit" };
                }
                if (parent.status !== "ACTIVE") {
                    return { ok: false,
                             reasonCode: parent.status === "REVOKED"
                                 ? "CAP_REVOKED"
                                 : parent.status === "EXPIRED"
                                     ? "CAP_EXPIRED"
                                     : "CAP_INACTIVE",
                             detail: "parent berubah status saat commit" };
                }
                if (Number.isFinite(expectParentGeneration) &&
                    parent.generation !== expectParentGeneration) {
                    return { ok: false,
                             reasonCode: "CAP_GENERATION_STALE",
                             detail: "parent bergeneration saat commit" };
                }

                const reserved = [...delegationReservations.values()]
                    .filter(v => v.parent === parentCapabilityId)
                    .reduce((sum, v) => sum + v.amount, 0);

                const parentMax = parent.payload?.maxExecutions;
                if (typeof parentMax === "number" &&
                    typeof reserveAmount === "number" &&
                    reserveAmount > parentMax - reserved) {
                    return { ok: false,
                             reasonCode: "CAP_DELEGATION_BUDGET_EXHAUSTED",
                             detail:
                                 `delegable budget habis: ` +
                                 `${reserved}/${parentMax} terpakai, ` +
                                 `diminta ${reserveAmount}` };
                }

                if (prevChild) {
                    return { ok: false, reasonCode: "CAP_MALFORMED",
                             detail: "capability_id child sudah ada" };
                }

                caps.set(childCapabilityId, {
                    status: childStatus,
                    generation: childGeneration,
                    payload: normalizeCapabilityPayload(childPayload)
                });
                delegationReservations.set(childCapabilityId, {
                    parent: parentCapabilityId,
                    amount: typeof reserveAmount === "number"
                        ? reserveAmount : 0,
                    at: new Date().toISOString()
                });
                for (const e of events ?? []) await api.appendEvent(e);
                return { ok: true, reservedTotal: reserved };
            }
            catch (error) {
                if (prevChild) caps.set(childCapabilityId, prevChild);
                else caps.delete(childCapabilityId);
                delegationReservations.delete(childCapabilityId);
                events.length = eventsMark;
                throw error;
            }
        },

        /**
         * ATOMIK anti-TOCTOU: seluruh revalidasi (exists/ACTIVE/generation/
         * notBefore/expiry/budget) terjadi pada unit atomik yang sama
         * dengan penulisan ledger konsumsi.
         */
        async consumeExecutionAtomic({ capabilityId, at, meta, nowMs }) {
            const entry = caps.get(capabilityId) ?? null;
            const prevStatus = entry?.status ?? null;
            const eventsMark = events.length;
            const payload = entry?.payload ?? null;
            const used = consumption.filter(
                c => c.capability_id === capabilityId).length;
            const curGen = entry
                ? (generations.get(payload?.subject) ?? 0)
                : undefined;

            try {
                const verdict = evaluateConsumption({
                    capEntry: entry, used, currentGeneration: curGen,
                    nowMs });
                if (!verdict.ok) {
                    return { ok: false, reasonCode: verdict.reasonCode,
                             detail: verdict.detail ?? null, used };
                }

                const cid = uuid();
                consumption.push({ consumption_id: cid,
                    capability_id: capabilityId, at, meta });
                const newUsed = used + 1;
                const max = payload.maxExecutions;
                const exhausted =
                    typeof max === "number" && newUsed === max;

                if (exhausted) {
                    entry.status = "EXHAUSTED";
                    await api.appendEvent({
                        eventId: uuid(), type: "CAPABILITY_EXHAUSTED",
                        capability_id: capabilityId, actor: "registry",
                        at, payload: { maxExecutions: max } });
                }
                await api.appendEvent(
                    consumptionEvent(capabilityId, at, newUsed, cid));

                return { ok: true, used: newUsed, consumptionId: cid,
                         exhausted, maxExecutions: max };
            }
            catch (error) {
                // Rollback: ledger + status + event kembali seperti semula.
                consumption.length = used;
                if (entry && prevStatus) entry.status = prevStatus;
                events.length = eventsMark;
                throw error;
            }
        }
    };

    return api;
}

/* ------------------------------------------------------------------ */
/* SQLITE BACKEND                                                       */
/* ------------------------------------------------------------------ */

function createSqliteAuthorityStore(database) {

    // Transaksi pada SATU koneksi harus serial — antrean in-process
    // menjamin BEGIN IMMEDIATE tidak pernah tumpang tindih dengan
    // statement lain dari registry yang berjalan konkuren.
    let txChain = Promise.resolve();

    function tx(work) {
        const run = txChain.then(() => rawTx(work));
        txChain = run.then(() => {}, () => {});
        return run;
    }

    async function rawTx(work) {
        await database.exec("BEGIN IMMEDIATE");
        try {
            const result = await work();
            await database.exec("COMMIT");
            return result;
        }
        catch (error) {
            try { await database.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }

    function rollbackResult(value) {
        // Melempar sentinel internal untuk membatalkan transaksi tanpa
        // mengubah hasil jadi exception bagi pemanggil.
        const err = new Error("__TX_DENY__");
        err.txDeny = value;
        return err;
    }

    return {
        backend: "sqlite",

        async upsertCapability(id, status, generation, payload) {
            const normalized = normalizeCapabilityPayload(payload);
            const encoded = JSON.stringify(normalized);
            await database.run(
                `INSERT INTO authority_capabilities (capability_id,status,subject,generation,payload)
                 VALUES (?,?,?,?,?)
                 ON CONFLICT(capability_id) DO UPDATE SET
                   status=excluded.status,
                   subject=excluded.subject,
                   generation=excluded.generation,
                   payload=excluded.payload`,
                [id, status, normalized.subject, generation, encoded]);
        },
        async getCapability(id) {
            const r = await database.get(
                "SELECT status,generation,payload FROM authority_capabilities WHERE capability_id=?",
                [id]);
            if (!r) return null;
            const p = JSON.parse(r.payload);
            return { status: r.status, generation: r.generation, payload: p };
        },
        async listCapabilitiesBySubject(subject) {
            const rows = await database.all(
                `SELECT capability_id,status,generation,payload FROM authority_capabilities
                  WHERE JSON_EXTRACT(payload,'$.subject')=?`, [subject]);
            return rows.map(r => ({
                capability_id: r.capability_id,
                status: r.status, generation: r.generation,
                payload: JSON.parse(r.payload)
            }));
        },

        async appendEvent(e) {
            await database.run(
                `INSERT INTO capability_events
                   (event_id,type,capability_id,actor,at,payload)
                 VALUES (?,?,?,?,?,?)`,
                [e.event_id ?? e.eventId, e.type, e.capability_id ?? null,
                 e.actor, e.at, JSON.stringify(e.payload ?? {})]);
        },
        async listEvents(capabilityId) {
            const rows = await database.all(
                `SELECT event_id AS eventId,type,capability_id AS capabilityId,
                        actor,at,payload
                   FROM capability_events WHERE capability_id=?
                  ORDER BY seq ASC`, [capabilityId]);
            return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
        },

        async countConsumption(capabilityId) {
            const r = await database.get(
                "SELECT COUNT(*) AS n FROM capability_consumption WHERE capability_id=?",
                [capabilityId]);
            return r.n;
        },

        async getGeneration(subject) {
            const r = await database.get(
                "SELECT generation FROM subject_generations WHERE subject=?",
                [subject]);
            return r ? r.generation : 0;
        },
        async bumpGeneration(subject, at) {
            await database.run(
                `INSERT INTO subject_generations (subject,generation,updated_at)
                 VALUES (?,1,?)
                 ON CONFLICT(subject) DO UPDATE SET
                   generation=generation+1, updated_at=excluded.updated_at`,
                [subject, at]);
            return this.getGeneration(subject);
        },

        async upsertRatification(r) {
            await database.run(
                `INSERT INTO owner_ratifications
                   (ratification_id,proposal_digest,decision,payload)
                 VALUES (?,?,?,?)
                 ON CONFLICT(ratification_id) DO UPDATE SET
                   proposal_digest=excluded.proposal_digest,
                   decision=excluded.decision,
                   payload=excluded.payload`,
                [r.ratificationId, r.proposalDigest ?? "", r.decision,
                 JSON.stringify(r)]);
        },
        async getRatification(rid) {
            const r = await database.get(
                `SELECT proposal_digest AS proposalDigest,decision,payload
                   FROM owner_ratifications WHERE ratification_id=?`, [rid]);
            if (!r) return null;
            const payload = JSON.parse(r.payload);
            return { ...payload, proposalDigest: r.proposalDigest,
                     decision: r.decision };
        },

        async upsertProposal(p) {
            await database.run(
                `INSERT INTO evolution_proposals
                   (proposal_id,revision,digest,status,payload)
                 VALUES (?,?,?,?,?)
                 ON CONFLICT(proposal_id) DO UPDATE SET
                   revision=excluded.revision, digest=excluded.digest,
                   status=excluded.status, payload=excluded.payload`,
                [p.proposalId, p.revision ?? 1, p.digest ?? "",
                 p.status ?? "DRAFT", JSON.stringify(p)]);
        },
        async getProposal(pid) {
            const r = await database.get(
                `SELECT revision,digest,status,payload FROM evolution_proposals
                  WHERE proposal_id=?`, [pid]);
            if (!r) return null;
            const payload = JSON.parse(r.payload);
            return { ...payload, revision: r.revision, digest: r.digest,
                     status: r.status };
        },

        async getDelegationReservations(parentCapabilityId) {
            const rows = await database.all(
                `SELECT child_capability_id AS childCapabilityId,
                        parent_capability_id AS parent, amount, at
                   FROM capability_delegations
                  WHERE parent_capability_id=?`,
                [parentCapabilityId]);
            return rows;
        },

        /** ATOMIK: ratifikasi one-shot + grant + event (§E/§F/§tx). */
        issueRootGrantAtomic({ capabilityId, status, generation, payload,
                               ratificationId, expectProposalDigest,
                               expectProposalRevision,
                               expectApprovedAuthorityDigest, events }) {
            return tx(async () => {
                const r = await database.get(
                    `SELECT decision,payload FROM owner_ratifications
                      WHERE ratification_id=?`, [ratificationId]);
                const rp = r ? JSON.parse(r.payload) : null;
                if (!r || r.decision !== "APPROVED") {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_RATIFICATION_REQUIRED",
                        detail: "ratifikasi APPROVED tidak ditemukan" });
                }
                if (rp.consumedAt) {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_RATIFICATION_CONSUMED",
                        detail: "ratifikasi sudah dikonsumsi " +
                                "(satu APPROVED = satu root grant)" });
                }
                if (rp.proposalDigest !== expectProposalDigest ||
                    (rp.proposalRevision ?? 1) !==
                        (expectProposalRevision ?? 1) ||
                    rp.approvedAuthorityDigest !==
                        expectApprovedAuthorityDigest) {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_RATIFICATION_REQUIRED",
                        detail: "binding ratifikasi tidak cocok (stale/tamper)" });
                }

                const existing = await database.get(
                    `SELECT status FROM authority_capabilities
                      WHERE capability_id=?`, [capabilityId]);
                const conflict =
                    terminalResurrectionConflict(existing?.status ?? null);
                if (conflict) throw rollbackResult(conflict);

                const normalized = normalizeCapabilityPayload(payload);
                await database.run(
                    `INSERT INTO authority_capabilities
                       (capability_id,status,subject,generation,payload)
                     VALUES (?,?,?,?,?)`,
                    [capabilityId, status, normalized.subject, generation,
                     JSON.stringify(normalized)]);

                rp.consumedAt = new Date().toISOString();
                rp.consumedByCapabilityId = capabilityId;
                await database.run(
                    `UPDATE owner_ratifications SET payload=?
                      WHERE ratification_id=?`,
                    [JSON.stringify(rp), ratificationId]);

                for (const e of events ?? []) {
                    await database.run(
                        `INSERT INTO capability_events
                           (event_id,type,capability_id,actor,at,payload)
                         VALUES (?,?,?,?,?,?)`,
                        [e.event_id ?? e.eventId, e.type,
                         e.capability_id ?? null, e.actor, e.at,
                         JSON.stringify(e.payload ?? {})]);
                }
                return { ok: true };
            }).catch(error => {
                if (error && error.txDeny) return error.txDeny;
                throw error;
            });
        },

        /** ATOMIK: revalidasi parent + reservasi + child + event. */
        delegateGrantAtomic({ childCapabilityId, childStatus,
                              childGeneration, childPayload,
                              parentCapabilityId,
                              expectParentGeneration,
                              reserveAmount, events }) {
            return tx(async () => {
                const parentRow = await database.get(
                    `SELECT status,generation,payload
                       FROM authority_capabilities WHERE capability_id=?`,
                    [parentCapabilityId]);
                if (!parentRow) {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_NOT_FOUND",
                        detail: "parent hilang saat commit" });
                }
                if (parentRow.status !== "ACTIVE") {
                    throw rollbackResult({
                        ok: false,
                        reasonCode: parentRow.status === "REVOKED"
                            ? "CAP_REVOKED"
                            : parentRow.status === "EXPIRED"
                                ? "CAP_EXPIRED" : "CAP_INACTIVE",
                        detail: "parent berubah status saat commit" });
                }
                if (Number.isFinite(expectParentGeneration) &&
                    parentRow.generation !== expectParentGeneration) {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_GENERATION_STALE",
                        detail: "parent bergeneration saat commit" });
                }

                const reservedRow = await database.get(
                    `SELECT COALESCE(SUM(amount),0) AS total
                       FROM capability_delegations
                      WHERE parent_capability_id=?`,
                    [parentCapabilityId]);
                const reserved = reservedRow.total;

                const parentMax =
                    JSON.parse(parentRow.payload).maxExecutions;
                if (typeof parentMax === "number" &&
                    typeof reserveAmount === "number" &&
                    reserveAmount > parentMax - reserved) {
                    throw rollbackResult({
                        ok: false,
                        reasonCode: "CAP_DELEGATION_BUDGET_EXHAUSTED",
                        detail: `delegable budget habis: ${reserved}/` +
                                `${parentMax} terpakai, diminta ` +
                                `${reserveAmount}` });
                }

                const dup = await database.get(
                    `SELECT capability_id FROM authority_capabilities
                      WHERE capability_id=?`, [childCapabilityId]);
                if (dup) {
                    throw rollbackResult({
                        ok: false, reasonCode: "CAP_MALFORMED",
                        detail: "capability_id child sudah ada" });
                }

                const normalized = normalizeCapabilityPayload(childPayload);
                await database.run(
                    `INSERT INTO authority_capabilities
                       (capability_id,status,subject,generation,payload)
                     VALUES (?,?,?,?,?)`,
                    [childCapabilityId, childStatus, normalized.subject,
                     childGeneration, JSON.stringify(normalized)]);

                await database.run(
                    `INSERT INTO capability_delegations
                       (child_capability_id,parent_capability_id,amount,at)
                     VALUES (?,?,?,?)`,
                    [childCapabilityId, parentCapabilityId,
                     typeof reserveAmount === "number" ? reserveAmount : 0,
                     new Date().toISOString()]);

                for (const e of events ?? []) {
                    await database.run(
                        `INSERT INTO capability_events
                           (event_id,type,capability_id,actor,at,payload)
                         VALUES (?,?,?,?,?,?)`,
                        [e.event_id ?? e.eventId, e.type,
                         e.capability_id ?? null, e.actor, e.at,
                         JSON.stringify(e.payload ?? {})]);
                }
                return { ok: true, reservedTotal: reserved };
            }).catch(error => {
                if (error && error.txDeny) return error.txDeny;
                throw error;
            });
        },

        /** ATOMIK anti-TOCTOU: revalidasi penuh + ledger + event. */
        consumeExecutionAtomic({ capabilityId, at, meta, nowMs }) {
            return tx(async () => {
                const row = await database.get(
                    `SELECT status,generation,payload
                       FROM authority_capabilities WHERE capability_id=?`,
                    [capabilityId]);
                const capEntry = row
                    ? { status: row.status, generation: row.generation,
                        payload: JSON.parse(row.payload) }
                    : null;

                let curGen;
                if (capEntry) {
                    const g = await database.get(
                        `SELECT generation FROM subject_generations
                          WHERE subject=?`, [capEntry.payload?.subject]);
                    curGen = g ? g.generation : 0;
                }

                const usedRow = await database.get(
                    `SELECT COUNT(*) AS n FROM capability_consumption
                      WHERE capability_id=?`, [capabilityId]);

                const verdict = evaluateConsumption({
                    capEntry, used: usedRow.n,
                    currentGeneration: curGen, nowMs });
                if (!verdict.ok) {
                    throw rollbackResult({
                        ok: false, reasonCode: verdict.reasonCode,
                        detail: verdict.detail ?? null, used: usedRow.n });
                }

                const cid = uuid();
                await database.run(
                    `INSERT INTO capability_consumption
                       (consumption_id,capability_id,at,meta)
                     VALUES (?,?,?,?)`,
                    [cid, capabilityId, at, JSON.stringify(meta ?? {})]);

                const newUsed = usedRow.n + 1;
                const max = capEntry.payload.maxExecutions;
                const exhausted =
                    typeof max === "number" && newUsed === max;

                if (exhausted) {
                    await database.run(
                        `UPDATE authority_capabilities SET status='EXHAUSTED'
                          WHERE capability_id=?`, [capabilityId]);
                    await database.run(
                        `INSERT INTO capability_events
                           (event_id,type,capability_id,actor,at,payload)
                         VALUES (?,?,?,?,?,?)`,
                        [uuid(), "CAPABILITY_EXHAUSTED", capabilityId,
                         "registry", at,
                         JSON.stringify({ maxExecutions: max })]);
                }

                const ev = consumptionEvent(capabilityId, at, newUsed, cid);
                await database.run(
                    `INSERT INTO capability_events
                       (event_id,type,capability_id,actor,at,payload)
                     VALUES (?,?,?,?,?,?)`,
                    [ev.event_id ?? ev.eventId, ev.type, ev.capability_id,
                     ev.actor, ev.at, JSON.stringify(ev.payload)]);

                return { ok: true, used: newUsed, consumptionId: cid,
                         exhausted, maxExecutions: max };
            }).catch(error => {
                if (error && error.txDeny) return error.txDeny;
                throw error;
            });
        }
    };
}

module.exports = {
    createMemoryAuthorityStore,
    createSqliteAuthorityStore,
    evaluateConsumption,
    terminalResurrectionConflict
};
