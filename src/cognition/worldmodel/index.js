"use strict";

/**
 * W7-L2 WORLD MODEL AND SITUATION GRAPH.
 *
 * ACC subdomain `src/cognition/worldmodel/**`, replacing legacy
 * `src/world/WorldModel.js`/`src/autonomy/EnvironmentModel.js` as the
 * canonical situation-graph owner (`W7_WORLD_MODEL_FORMAL_SPEC.md`).
 *
 * WORLD MODEL != GROUND TRUTH. Every answer carries its epistemic envelope
 * (Q-1); nothing here mints authority, permission, or fact.
 *
 * SCOPE OF THIS INCREMENT: the full LOCAL_ONLY path (spec §1-7, §9-13).
 * Distributed replication (§8, `REPLICATED_CONVERGENT` via dstate merge
 * policy) is explicitly deferred — the dependency DAG itself marks dstate
 * as a SOFT dependency for this lane with LOCAL_ONLY as the sanctioned
 * fallback when it is not yet wired. Freeze criterion #4 (two-node
 * deterministic merge) stays OPEN until that integration happens.
 */

const crypto = require("node:crypto");
const { REASONS, fail } = require("./errors");
const { BOUNDS, SCHEMA_VERSION } = require("./bounds");
const { laws } = require("./laws");
const { makeEntity, makeRelation, makeObservation, makeHypothesis } = require("./records");
const { DEFAULT_DECAY_POLICY, applyRevision } = require("./beliefAlgebra");
const { openContradictionSet, resolveContradictionSet } = require("./contradiction");
const graphOps = require("./graph");
const { beliefKey, subjectKeyOf, query: queryBelief } = require("./query");
const { loadSnapshot, saveSnapshot } = require("./store");

async function createWorldModel({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {

    const snapshot = await loadSnapshot(store);
    const entities = snapshot.entities;
    const relations = snapshot.relations;
    const beliefs = snapshot.beliefs;
    const hypotheses = snapshot.hypotheses;
    let contradictions = snapshot.contradictions;
    const coldStart = snapshot.coldStart;

    const entityCountBySource = new Map();
    for (const e of entities.values()) {
        entityCountBySource.set(e.source, (entityCountBySource.get(e.source) ?? 0) + 1);
    }

    function now() { return clock.nowMs(); }
    function nowIso() { return new Date(now()).toISOString(); }

    // Bug review independen (audit putaran-4, W7R4-P2-3): nilai hanya
    // diturunkan ke 0, kuncinya sendiri tidak pernah dihapus -- satu entri
    // Map menumpuk selamanya per string `source` berbeda yang pernah dipakai.
    function decrementSourceCount(source) {
        const next = Math.max(0, (entityCountBySource.get(source) ?? 1) - 1);
        if (next === 0) entityCountBySource.delete(source);
        else entityCountBySource.set(source, next);
    }

    function relationDegree(entityId) {
        let degree = 0;
        for (const r of relations.values()) {
            if (r.from === entityId || r.to === entityId) degree += 1;
        }
        return degree;
    }

    /**
     * §11 overflow: evict by lastSeenAt AND low relation degree. Bug
     * diketemukan review independen (Codex, putaran ke-3): implementasi
     * lama hanya memakai lastSeenAt, sehingga entitas lama yang sangat
     * terhubung bisa dievict sementara entitas baru yang terisolasi
     * bertahan — merusak konektivitas graf. Sekarang derajat relasi
     * adalah kunci utama (evict yang paling sedikit terhubung dulu),
     * lastSeenAt sebagai pemecah seri di antara kandidat berderajat sama.
     */
    function evictEntityIfOverBound() {
        if (entities.size <= bounds.MAX_ENTITIES) return;
        let victim = null;
        let victimDegree = Infinity;
        for (const e of entities.values()) {
            const degree = relationDegree(e.entityId);
            if (!victim || degree < victimDegree ||
                (degree === victimDegree && e.lastSeenAt < victim.lastSeenAt)) {
                victim = e;
                victimDegree = degree;
            }
        }
        if (victim) {
            entities.delete(victim.entityId);
            decrementSourceCount(victim.source);
            // Bug review independen (Codex putaran-6): relasi yang masih
            // menunjuk ke entitas yang baru dievict dulu dibiarkan, jadi
            // path/subgraph bisa melewati endpoint yang sudah tidak ada.
            for (const r of [...relations.values()]) {
                if (r.from === victim.entityId || r.to === victim.entityId) relations.delete(r.relationId);
            }
        }
    }

    function evictRelationIfOverBound() {
        if (relations.size <= bounds.MAX_RELATIONS) return;
        let victim = null;
        for (const r of relations.values()) {
            if (!victim || r.strength < victim.strength) victim = r;
        }
        if (victim) relations.delete(victim.relationId);
    }

    function declareEntity({ entityId, entityKind, labels, externalRefs, source }) {
        const existing = entities.get(entityId);
        // Bug diketemukan review independen (Codex): deklarasi ulang dengan
        // `source` BERBEDA dulu menimpa entitas tanpa menyesuaikan hitungan
        // kuota sumber lama/baru — celah untuk melampaui MAX_ENTITIES_PER_SOURCE.
        const isSourceChange = existing && existing.source !== source;
        const count = entityCountBySource.get(source) ?? 0;
        if ((!existing || isSourceChange) && count >= bounds.MAX_ENTITIES_PER_SOURCE) {
            fail(REASONS.QUOTA_EXCEEDED, `sumber '${source}' melebihi kuota entitas (WM-A6)`);
        }
        const entity = makeEntity({ entityId, entityKind, labels, externalRefs, source, nowMs: now() });
        entities.set(entityId, existing ? { ...entity, firstSeenAt: existing.firstSeenAt } : entity);
        if (!existing) {
            entityCountBySource.set(source, count + 1);
        } else if (isSourceChange) {
            decrementSourceCount(existing.source);
            entityCountBySource.set(source, count + 1);
        }
        evictEntityIfOverBound();
        return entities.get(entityId);
    }

    function declareRelation(spec) {
        const relation = makeRelation(spec);
        if (!entities.has(relation.from) || !entities.has(relation.to)) {
            fail(REASONS.UNKNOWN_ENTITY, "relasi merujuk entitas yang belum dideklarasikan");
        }
        relations.set(relation.relationId, relation);
        evictRelationIfOverBound();
        return relation;
    }

    function applyRecordToBelief(record) {
        const subjectKey = subjectKeyOf(record.subject);
        const key = beliefKey(record.subject, record.attribute);
        const existing = beliefs.get(key);

        // Bug review independen (audit putaran-7, W7R7-P1-3): beliefs tidak
        // punya batas total sama sekali -- attribute string bebas milik
        // pemanggil (ingestObservation/ingestDeclaration) berarti satu
        // entitas bisa memicu beliefs tak terbatas. Cek HANYA saat key ini
        // BARU (existing null) supaya tidak pernah mengevict belief yang
        // baru saja dibuat/direvisi di panggilan ini sendiri.
        if (!existing && beliefs.size >= bounds.MAX_TOTAL_BELIEFS) {
            let victimKey = null, victimUpdatedAtMs = Infinity;
            for (const [k, b] of beliefs) {
                if (b.updatedAtMs < victimUpdatedAtMs) { victimUpdatedAtMs = b.updatedAtMs; victimKey = k; }
            }
            if (victimKey !== null) beliefs.delete(victimKey);
        }

        const { case: caseName, belief, contradiction } = applyRevision({
            existing, record: { ...record, subjectKey }, nowMs: now(), decayPolicy: DEFAULT_DECAY_POLICY
        });

        if (caseName === "CONTEST") {
            const { list, entry } = openContradictionSet(contradictions, contradiction, nowIso(), bounds.MAX_OPEN_CONTRADICTION_SETS);
            contradictions = list;
            const contested = Object.freeze({ ...existing, contradictionSetId: entry.contradictionSetId });
            beliefs.set(key, contested);
            return { case: caseName, belief: contested, contradictionSetId: entry.contradictionSetId };
        }

        beliefs.set(key, belief);
        return { case: caseName, belief, contradictionSetId: null };
    }

    function ingestObservation(spec) {
        const observation = makeObservation({ ...spec, observationId: spec.observationId ?? crypto.randomUUID() });
        const entityId = observation.subject.entityId;
        if (entityId && !entities.has(entityId)) {
            fail(REASONS.UNKNOWN_ENTITY, "observasi merujuk entitas yang belum dideklarasikan");
        }
        if (observation.subject.entityId) {
            const e = entities.get(observation.subject.entityId);
            entities.set(e.entityId, { ...e, lastSeenAt: now() });
        }
        // Bug review independen (Codex putaran-9): `Date.parse(...) || now()`
        // memakai kebenaran-tanpa-syarat -- observedAt persis epoch
        // (1970-01-01T00:00:00.000Z -> 0) dianggap "falsy" dan diam-diam
        // diganti now(), memalsukan observasi epoch sebagai baru saja terjadi.
        const parsedObservedAtMs = Date.parse(observation.observedAt);
        return applyRecordToBelief({
            recordId: observation.observationId, subject: observation.subject,
            attribute: observation.attribute, value: observation.value,
            tier: observation.tier, observedAt: observation.observedAt,
            observedAtMs: Number.isFinite(parsedObservedAtMs) ? parsedObservedAtMs : now()
        });
    }

    /** W-1: pernyataan DECLARED pemilik — jalur admissible terpisah dari observasi sensor. */
    function ingestDeclaration({ subject, attribute, value, declarationId, at }) {
        if (!subject || (typeof subject.entityId !== "string" && typeof subject.relationId !== "string")) {
            fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
        }
        return applyRecordToBelief({
            recordId: declarationId ?? crypto.randomUUID(), subject, attribute, value,
            tier: "DECLARED", observedAt: at ?? nowIso(), observedAtMs: now()
        });
    }

    function declareHypothesis(spec) {
        if (hypotheses.size >= bounds.MAX_HYPOTHESES) {
            // §11: kadaluwarsa dulu, lalu bobot terendah.
            const sorted = [...hypotheses.values()].sort((a, b) =>
                (Date.parse(a.expiresAt) - Date.parse(b.expiresAt)));
            if (sorted[0]) hypotheses.delete(sorted[0].hypothesisId);
        }
        const h = makeHypothesis(spec);
        hypotheses.set(h.hypothesisId, h);
        return h;
    }

    function query(spec) { return queryBelief(beliefs, spec, now()); }

    function openContradictions() { return contradictions.filter(c => c.status === "OPEN"); }

    function resolveContradiction(contradictionSetId, ruleId) {
        contradictions = resolveContradictionSet(contradictions, contradictionSetId, ruleId, nowIso());
        return contradictions.find(c => c.contradictionSetId === contradictionSetId);
    }

    function stateView() { return { entities, relations }; }
    function entityCountBySourceSize() { return entityCountBySource.size; }
    function beliefsSize() { return beliefs.size; }

    async function persist() {
        return saveSnapshot(store, { entities, relations, beliefs, hypotheses, contradictions });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        worldModelColdStart: coldStart,
        declareEntity, declareRelation, declareHypothesis,
        ingestObservation, ingestDeclaration,
        query,
        neighbors: (id, kinds, depth) => graphOps.neighbors(stateView(), id, kinds, depth),
        subgraph: (seeds, depth, budget) => graphOps.subgraph(stateView(), seeds, depth, budget),
        path: (from, to, maxDepth) => graphOps.path(stateView(), from, to, maxDepth),
        entitiesByKind: (kind, limit) => graphOps.entitiesByKind(stateView(), kind, limit),
        openContradictions, resolveContradiction, entityCountBySourceSize, beliefsSize,
        persist, laws, bounds
    });
}

module.exports = { createWorldModel, laws, BOUNDS };
