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
const { DEFAULT_DECAY_POLICY, applyRevision, appendBounded } = require("./beliefAlgebra");
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
    // Bug review independen (audit putaran-16, AUD16-P2-2): openContradictionSet
    // mengembalikan `evicted` (arsip UNRESOLVABLE/OVERFLOW_ARCHIVE) supaya
    // pemanggil bisa mengeskalasi ke metakognisi/audit -- tapi tidak pernah
    // dipakai, jadi kontradiksi yang belum terselesaikan hilang diam-diam
    // begitu daftar kontradiksi terbatas overflow. Diarsipkan di sini,
    // dibatasi sendiri, supaya bisa diambil lewat overflowedContradictions().
    // Bug review independen (audit putaran-19, AUD19-P2-2): dulu SELALU
    // dimulai dari [] di sini, tidak pernah dimuat dari snapshot -- arsip
    // overflow hilang lagi setelah restart, membalikkan tepat fix yang
    // dimaksudkan AUD16-P2-2.
    const overflowedContradictions = [...(snapshot.overflowedContradictions ?? [])];

    const entityCountBySource = new Map();
    for (const e of entities.values()) {
        entityCountBySource.set(e.source, (entityCountBySource.get(e.source) ?? 0) + 1);
    }

    // Bug review independen (audit putaran-20, AUD20-P2-3): evictEntityIfOverBound
    // memanggil relationDegree(id) -- pemindaian PENUH `relations` -- untuk
    // SETIAP entitas kandidat korban, jadi O(entitas x relasi) per panggilan.
    // Pada batas produksi (100000 entitas x 400000 relasi) ini butuh menit
    // CPU per declareEntity() begitu kapasitas tercapai (DoS CPU/latensi).
    // Indeks derajat inkremental dijaga di sini (pola sama seperti
    // entityCountBySource di atas) supaya relationDegree() jadi O(1); satu-
    // satunya biaya O(R) tersisa adalah inisialisasi ini sekali saat startup.
    const degreeByEntity = new Map();
    function incDegree(entityId) {
        degreeByEntity.set(entityId, (degreeByEntity.get(entityId) ?? 0) + 1);
    }
    function decDegree(entityId) {
        const next = Math.max(0, (degreeByEntity.get(entityId) ?? 1) - 1);
        if (next === 0) degreeByEntity.delete(entityId);
        else degreeByEntity.set(entityId, next);
    }
    for (const r of relations.values()) {
        incDegree(r.from);
        incDegree(r.to);
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
        return degreeByEntity.get(entityId) ?? 0;
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
    // Bug review independen (audit putaran-17, AUD17-P2-4): entitas yang
    // BARU SAJA dideklarasikan (protectedEntityId) tidak pernah dikecualikan
    // dari kandidat korban -- derajat relasinya 0 dan lastSeenAt-nya paling
    // baru, jadi kalau semua entitas lain sudah terhubung, entitas yang
    // baru dibuat sendiri yang dievict. declareEntity() lalu
    // `entities.get(entityId)` mengembalikan undefined -- deklarasi yang
    // "diterima" hilang diam-diam. Pola yang sama dengan createPlan's
    // W7R7-P2-1 (jangan pernah mengevict record yang baru saja dibuat SENDIRI
    // dalam panggilan ini).
    function evictEntityIfOverBound(protectedEntityId = null) {
        if (entities.size <= bounds.MAX_ENTITIES) return;
        let victim = null;
        let victimDegree = Infinity;
        for (const e of entities.values()) {
            if (e.entityId === protectedEntityId) continue;
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
                if (r.from === victim.entityId || r.to === victim.entityId) {
                    relations.delete(r.relationId);
                    decDegree(r.from);
                    decDegree(r.to);
                }
            }
        }
    }

    // Bug review independen (audit putaran-18, AUD18-P2-1): pola yang sama
    // yang sudah diperbaiki untuk entitas (AUD17-P2-4, protectedEntityId)
    // tidak pernah dimigrasikan ke relasi -- relasi yang BARU SAJA
    // dideklarasikan (strength rendah, kandidat korban wajar) bisa dievict
    // di panggilan yang SAMA, declareRelation tetap mengembalikannya seolah
    // diterima padahal sudah tidak ada di state kanonik.
    function evictRelationIfOverBound(protectedRelationId = null) {
        if (relations.size <= bounds.MAX_RELATIONS) return;
        let victim = null;
        for (const r of relations.values()) {
            if (r.relationId === protectedRelationId) continue;
            if (!victim || r.strength < victim.strength) victim = r;
        }
        if (victim) {
            relations.delete(victim.relationId);
            decDegree(victim.from);
            decDegree(victim.to);
        }
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
        // Bug review independen (audit putaran-9, AUD9-P1-2): spread pasca-
        // makeEntity() menghasilkan objek POLOS TAK DIBEKUKAN -- pemanggil
        // yang menyimpan hasil declareEntity/entitiesByKind bisa memutasi
        // entityKind/source kanonik dalam sesi yang sama tanpa restart,
        // bahkan merusak akuntansi entityCountBySource pada deklarasi ulang
        // berikutnya (decrement pakai existing.source yang sudah dipalsukan).
        entities.set(entityId, existing ? Object.freeze({ ...entity, firstSeenAt: existing.firstSeenAt }) : entity);
        if (!existing) {
            entityCountBySource.set(source, count + 1);
        } else if (isSourceChange) {
            decrementSourceCount(existing.source);
            entityCountBySource.set(source, count + 1);
        }
        evictEntityIfOverBound(entityId);
        return entities.get(entityId);
    }

    function declareRelation(spec) {
        // Bug review independen (audit putaran-19, AUD19-A3): sapuan dedup
        // replay id putaran-9/10/13 mencakup observationId/declarationId/
        // hypothesisId/goalId/dll, tapi tidak pernah mencakup relationId --
        // replay sebuah relationId yang sudah ada diam-diam menimpa
        // topologi/strength relasi tersimpan.
        if (spec.relationId && relations.has(spec.relationId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `relationId '${spec.relationId}' sudah ada`);
        }
        const relation = makeRelation(spec);
        if (!entities.has(relation.from) || !entities.has(relation.to)) {
            fail(REASONS.UNKNOWN_ENTITY, "relasi merujuk entitas yang belum dideklarasikan");
        }
        relations.set(relation.relationId, relation);
        incDegree(relation.from);
        incDegree(relation.to);
        evictRelationIfOverBound(relation.relationId);
        return relation;
    }

    function applyRecordToBelief(record) {
        const subjectKey = subjectKeyOf(record.subject);
        const key = beliefKey(record.subject, record.attribute);
        const existing = beliefs.get(key);

        // Bug review independen (audit putaran-14, AUD14-P1-2): kompaksi
        // (menghapus belief valid lain) dulu berjalan SEBELUM applyRevision
        // -- satu-satunya tempat record.value/subject benar-benar disaring
        // (buildSafeBeliefValue) -- sehingga sebuah observasi/deklarasi yang
        // DITOLAK (mis. BigInt pada value) tetap mengevict satu belief VALID
        // sebelum error dilempar, kehilangan data permanen. applyRevision
        // sekarang dipanggil DULU; kompaksi hanya terjadi setelah belief
        // yang akan disimpan terbukti valid.
        const { case: caseName, belief, contradiction } = applyRevision({
            existing, record: { ...record, subjectKey }, nowMs: now(), decayPolicy: DEFAULT_DECAY_POLICY
        });

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

        if (caseName === "CONTEST") {
            // Bug review independen (audit putaran-10, AUD10-P1-3): replay
            // dari challengerRecordId yang sama (pengiriman ulang observasi/
            // deklarasi yang belum pernah masuk supportedBy karena nilainya
            // ditolak sebagai CONTEST) dulu membuka kontradiksi BARU setiap
            // kali -- mengevict/meng-overflow-archive kontradiksi sah lain
            // yang masih terbuka. recordId yang sama tidak boleh membuka
            // kontradiksi kedua.
            // Bug review independen (audit putaran-14, AUD14-P2-1; diperdalam
            // putaran-15, AUD15-P1-1): dedup di atas hanya mencari
            // `contradictions` yang MASIH tertahan -- begitu daftar terbatas
            // itu overflow (MAX_OPEN_CONTRADICTION_SETS), entri challenger
            // yang sudah di-replay hilang. Perbaikan putaran-14 mencatat
            // challengerRecordId ke `appliedRecordIds`, TAPI itu dibatasi
            // hanya 32 entri (MAX_OBSERVATIONS_RETAINED_PER_BELIEF) -- horizon
            // yang jauh lebih sempit dari horizon retensi contradiction set
            // (4096), jadi klaim "permanen" salah untuk belief yang menerima
            // >32 record lain setelahnya. `contestedRecordIds` sekarang
            // horizon terpisah, disamakan dengan MAX_OPEN_CONTRADICTION_SETS,
            // supaya tidak pernah lebih sempit dari tempat ia diperiksa.
            const alreadyOpen = contradictions.find(c => c.challengerRecordId === contradiction.challengerRecordId);
            if (alreadyOpen) {
                return { case: "DUPLICATE", belief: existing, contradictionSetId: alreadyOpen.contradictionSetId };
            }
            const { list, entry, evicted } = openContradictionSet(contradictions, contradiction, nowIso(), bounds.MAX_OPEN_CONTRADICTION_SETS);
            contradictions = list;
            if (evicted) {
                overflowedContradictions.push(evicted);
                if (overflowedContradictions.length > bounds.MAX_OPEN_CONTRADICTION_SETS) overflowedContradictions.shift();
            }
            const nextContestedRecordIds = Object.freeze(appendBounded(
                existing.contestedRecordIds ?? [], contradiction.challengerRecordId,
                bounds.MAX_OPEN_CONTRADICTION_SETS));
            const contested = Object.freeze({ ...existing, contradictionSetId: entry.contradictionSetId, contestedRecordIds: nextContestedRecordIds });
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
        // Bug review independen (Codex putaran-9): `Date.parse(...) || now()`
        // memakai kebenaran-tanpa-syarat -- observedAt persis epoch
        // (1970-01-01T00:00:00.000Z -> 0) dianggap "falsy" dan diam-diam
        // diganti now(), memalsukan observasi epoch sebagai baru saja terjadi.
        const parsedObservedAtMs = Date.parse(observation.observedAt);
        // Bug review independen (audit putaran-17, AUD17-P2-3): entity's
        // lastSeenAt dulu disentuh SEBELUM applyRecordToBelief -- satu-satunya
        // tempat `value` benar-benar divalidasi (buildSafeBeliefValue). Sebuah
        // observasi yang DITOLAK (mis. BigInt pada value) tetap memperbarui
        // lastSeenAt, membuat entitas terlihat baru dipakai dan melindunginya
        // dari eviksi (evictEntityIfOverBound memakai lastSeenAt sebagai
        // pemecah seri). Disentuh HANYA setelah observasi terbukti valid.
        const result = applyRecordToBelief({
            recordId: observation.observationId, subject: observation.subject,
            attribute: observation.attribute, value: observation.value,
            tier: observation.tier, observedAt: observation.observedAt,
            observedAtMs: Number.isFinite(parsedObservedAtMs) ? parsedObservedAtMs : now()
        });
        if (entityId) {
            const e = entities.get(entityId);
            entities.set(e.entityId, Object.freeze({ ...e, lastSeenAt: now() }));
        }
        return result;
    }

    /** W-1: pernyataan DECLARED pemilik — jalur admissible terpisah dari observasi sensor. */
    function ingestDeclaration({ subject, attribute, value, declarationId, at }) {
        if (!subject || (typeof subject.entityId !== "string" && typeof subject.relationId !== "string")) {
            fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
        }
        // Bug review independen (audit putaran-11, AUD11-P2-3): `at ?? nowIso()`
        // hanya menangkap null/undefined -- BigInt (atau string tak-tanggal)
        // lolos apa adanya, lalu BigInt meledakkan JSON.stringify di
        // saveSnapshot() saat persist(). ingestObservation sudah mewajibkan
        // observedAt yang valid lewat makeObservation; ingestDeclaration
        // adalah jalur konstruksi terpisah yang tidak pernah ikut disamakan.
        if (at !== undefined && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) {
            fail(REASONS.INVALID_RECORD, "'at', jika ada, wajib tanggal ISO string yang sah");
        }
        // Bug review independen (audit putaran-12, AUD12-P2-1): perbaikan
        // putaran-11 hanya menyaring `at` -- `attribute`/`declarationId`
        // tetap diteruskan mentah ke applyRecordToBelief; BigInt di salah
        // satunya meledakkan JSON.stringify saat persist(), dan `attribute`
        // berupa objek referensi mengumpulkan setiap deklarasi berbeda ke
        // satu kunci belief yang sama ("[object Object]").
        if (typeof attribute !== "string" || !attribute) {
            fail(REASONS.INVALID_RECORD, "attribute wajib string tidak kosong");
        }
        if (declarationId !== undefined && (typeof declarationId !== "string" || !declarationId)) {
            fail(REASONS.INVALID_RECORD, "declarationId, jika ada, wajib string tidak kosong");
        }
        return applyRecordToBelief({
            recordId: declarationId ?? crypto.randomUUID(), subject, attribute, value,
            tier: "DECLARED", observedAt: at ?? nowIso(), observedAtMs: now()
        });
    }

    function declareHypothesis(spec) {
        // Bug review independen (audit putaran-13, AUD13-P2-4): hypothesisId
        // tidak pernah dicek tabrakan -- replay sebuah hypothesisId yang
        // sudah ada diam-diam menimpa candidateValues/expiresAt tersimpan,
        // pola yang sama yang sudah ditutup untuk observationId/
        // declarationId (putaran 9) dan id goals/prospective (putaran 10)
        // tapi tidak pernah dimigrasikan ke worldmodel's hypothesisId.
        if (spec.hypothesisId && hypotheses.has(spec.hypothesisId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `hypothesisId '${spec.hypothesisId}' sudah ada`);
        }
        // Bug review independen (audit putaran-14, AUD14-P1-2): kompaksi
        // (menghapus hipotesis valid lain) dulu berjalan SEBELUM
        // makeHypothesis memvalidasi spec -- spec yang ditolak (mis.
        // expiresAt cacat) tetap mengevict satu hipotesis VALID sebelum
        // error dilempar, kehilangan data permanen. Validasi/bangun record
        // DULU, baru kompaksi+simpan.
        const h = makeHypothesis(spec);
        if (hypotheses.size >= bounds.MAX_HYPOTHESES) {
            // §11: kadaluwarsa dulu, lalu bobot terendah.
            const sorted = [...hypotheses.values()].sort((a, b) =>
                (Date.parse(a.expiresAt) - Date.parse(b.expiresAt)));
            if (sorted[0]) hypotheses.delete(sorted[0].hypothesisId);
        }
        hypotheses.set(h.hypothesisId, h);
        return h;
    }

    function query(spec) { return queryBelief(beliefs, spec, now()); }

    function openContradictions() { return contradictions.filter(c => c.status === "OPEN"); }
    /** AUD16-P2-2: kontradiksi yang belum terselesaikan (status masih OPEN saat overflow) yang terdorong keluar dari daftar terbatas. */
    function overflowedContradictionsView() { return [...overflowedContradictions]; }

    function resolveContradiction(contradictionSetId, ruleId) {
        contradictions = resolveContradictionSet(contradictions, contradictionSetId, ruleId, nowIso());
        return contradictions.find(c => c.contradictionSetId === contradictionSetId);
    }

    function stateView() { return { entities, relations }; }
    function entityCountBySourceSize() { return entityCountBySource.size; }
    function beliefsSize() { return beliefs.size; }

    async function persist() {
        return saveSnapshot(store, { entities, relations, beliefs, hypotheses, contradictions, overflowedContradictions });
    }

    return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        worldModelColdStart: coldStart,
        declareEntity, declareRelation, declareHypothesis,
        ingestObservation, ingestDeclaration,
        query,
        // Bug review independen (audit putaran-18, AUD18-A3): tanpa default,
        // depth yang dihilangkan pemanggil menjadi undefined -> Math.min(undefined,...)
        // = NaN di graphOps.neighbors, membuat loop traversal berjalan NOL kali
        // dan diam-diam mengembalikan hasil kosong.
        neighbors: (id, kinds, depth = 1) => graphOps.neighbors(stateView(), id, kinds, depth),
        subgraph: (seeds, depth, budget) => graphOps.subgraph(stateView(), seeds, depth, budget),
        path: (from, to, maxDepth) => graphOps.path(stateView(), from, to, maxDepth),
        entitiesByKind: (kind, limit) => graphOps.entitiesByKind(stateView(), kind, limit),
        openContradictions, overflowedContradictions: overflowedContradictionsView, resolveContradiction, entityCountBySourceSize, beliefsSize,
        persist, laws, bounds
    });
}

module.exports = { createWorldModel, laws, BOUNDS };
