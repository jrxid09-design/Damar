/**
 * AUTHORITY STORE — memory & sqlite backends, semantik identik.
 *
 * consumeExecution() adalah operasi ATOMIK (§H): pengecekan status/budget
 * + penulisan ledger + transisi EXHAUSTED terjadi dalam SATU unit; SQLite
 * memakai BEGIN IMMEDIATE ... COMMIT/ROLLBACK.
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

function createMemoryAuthorityStore() {
    const caps = new Map();      // id -> {status,payload}
    const events = [];
    const consumption = [];      // {consumption_id,capability_id,at}
    const generations = new Map();
    const ratifications = new Map();
    const proposals = new Map();

    return {
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

        // ---- konsumsi atomik (memory: single-thread by construction) ---
        async consumeExecution({ capabilityId, maxExecutions, at, meta }) {
            const used = consumption.filter(
                c => c.capability_id === capabilityId).length;
            if (used >= maxExecutions) return { ok: false, used };
            const cid = uuid();
            consumption.push({ consumption_id: cid,
                capability_id: capabilityId, at, meta });
            const newUsed = used + 1;
            return { ok: true, used: newUsed, consumptionId: cid,
                     exhausted: maxExecutions === newUsed };
        },
        async countConsumption(capabilityId) {
            return consumption.filter(c => c.capability_id === capabilityId).length;
        },

        async getGeneration(subject) {
            return generations.get(subject) ?? 0;
        },
        async bumpGeneration(subject, at) {
            const g = (generations.get(subject) ?? 0) + 1;
            generations.set(subject, g);
            return g;
        },

        async upsertRatification(r) { ratifications.set(r.ratificationId, r); },
        async getRatification(rid)   { return ratifications.get(rid) ?? null; },

        async upsertProposal(p)     { proposals.set(p.proposalId, p); },
        async getProposal(pid)      { return proposals.get(pid) ?? null; }
    };
}

function createSqliteAuthorityStore(database) {

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

        /**
         * ATOMIK (§H): BEGIN IMMEDIATE menahan writer lain; cek budget,
         * insert ledger, dan transisi EXHAUSTED dalam satu transaksi.
         */
        consumeExecution: (() => {
            return async function ({ capabilityId, maxExecutions, at, meta }) {
                await database.exec("BEGIN IMMEDIATE");
                try {
                    const cap = await database.get(
                        `SELECT status FROM authority_capabilities WHERE capability_id=?`,
                        [capabilityId]);
                    const usedRow = await database.get(
                        `SELECT COUNT(*) AS n FROM capability_consumption
                          WHERE capability_id=?`, [capabilityId]);
                    const used = usedRow.n;

                    if (!cap || cap.status !== "ACTIVE" || used >= maxExecutions) {
                        await database.exec("ROLLBACK");
                        return { ok: false, used };
                    }

                    const cid = uuid();
                    await database.run(
                        `INSERT INTO capability_consumption
                           (consumption_id,capability_id,at,meta)
                         VALUES (?,?,?,?)`,
                        [cid, capabilityId, at, JSON.stringify(meta ?? {})]);

                    const newUsed = used + 1;
                    if (newUsed === maxExecutions) {
                        await database.run(
                            "UPDATE authority_capabilities SET status='EXHAUSTED' WHERE capability_id=?",
                            [capabilityId]);
                        await database.run(
                            `INSERT INTO capability_events
                               (event_id,type,capability_id,actor,at,payload)
                             VALUES (?,?,?,?,?,?)`,
                            [uuid(), "CAPABILITY_EXHAUSTED", capabilityId,
                             "registry", at,
                             JSON.stringify({ maxExecutions })]);
                    }

                    await database.exec("COMMIT");
                    return { ok: true, used: newUsed,
                             consumptionId: cid,
                             exhausted: newUsed === maxExecutions };
                }
                catch (error) {
                    try { await database.exec("ROLLBACK"); } catch {}
                    throw error;
                }
            };
        })(),
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
        }
    };
}

module.exports = { createMemoryAuthorityStore, createSqliteAuthorityStore };
