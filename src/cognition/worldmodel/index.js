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
const { sanitizeBounds } = require("../core/bounds");
const { laws } = require("./laws");
const { makeEntity, makeRelation, makeObservation, makeHypothesis } = require("./records");
const { DEFAULT_DECAY_POLICY, applyRevision, appendBounded, buildSafeBeliefValue } = require("./beliefAlgebra");
const { openContradictionSet, resolveContradictionSet } = require("./contradiction");
const graphOps = require("./graph");
const { beliefKey, subjectKeyOf, query: queryBelief } = require("./query");
const { loadSnapshot, saveSnapshot } = require("./store");

async function createWorldModel({ clock = { nowMs: () => Date.now() }, store = null, bounds = BOUNDS } = {}) {

    // Bug review independen (audit putaran-53, AUD53-P2-2): `bounds` yang
    // dioverride pemanggil dibaca mentah di puluhan titik di seluruh lane
    // ini -- Proxy yang di-revoke raw-throw pada baca PERTAMA. Dinormalisasi
    // SEKALI di sini (spread memicu trap `ownKeys` kalau ada); field yang
    // hilang jatuh ke `BOUNDS` asli, bukan `undefined`.
    // Bug review independen (audit putaran-57, Codex, W7R57-P2-1):
    // normalisasi lama hanya memvalidasi `bounds` ITU SENDIRI sebagai
    // objek, bukan tiap NILAI override -- Infinity/NaN/negatif pada satu
    // MAX_* melumpuhkan batas itu. sanitizeBounds memvalidasi per key.
    try {
        bounds = sanitizeBounds(BOUNDS, bounds);
    } catch {
        bounds = BOUNDS;
    }

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

    // Bug review independen (audit putaran-53, AUD53-P2-2): `clock.nowMs()`
    // mentah -- Proxy yang di-revoke (atau `nowMs` yang melempar/bukan
    // fungsi/non-finite) raw-throw dari setiap pemanggil now()/nowIso().
    function now() {
        let candidate;
        try {
            candidate = typeof clock?.nowMs === "function" ? clock.nowMs() : undefined;
        } catch {
            candidate = undefined;
        }
        return Number.isFinite(candidate) ? candidate : Date.now();
    }
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
        // Bug review independen (audit putaran-60, OpenCode, W7R60-P2-1):
        // kapasitas 0 (sanksi sah lewat sanitizeBounds) dengan
        // `protectedEntityId` sebagai SATU-SATUNYA entitas -- filter
        // kandidat mengecualikannya, tidak ada korban ditemukan, entitas
        // baru tetap tersimpan, melampaui cap total 0. Sibling PERSIS
        // dari kelas round-59 (attention evictLowestIfOverflow), belum
        // disapu ke sini. Pada kapasitas 0, proteksi dilepas.
        // Bug review independen (audit putaran-61, Codex, AUD61-P2-1,
        // BLOCKING, kelas umum): menghapus SATU korban per panggilan tidak
        // pernah benar-benar mengompaksi turun kalau store dimuat ulang
        // dengan bound yang lebih rendah dari saat data itu dipersist --
        // populasi pra-ada bisa jauh melebihi bound baru. Loop sampai
        // benar-benar patuh, bukan cuma satu langkah per panggilan.
        const maxEntities = Math.max(0, Math.trunc(bounds.MAX_ENTITIES));
        const effectiveProtected = maxEntities === 0 ? null : protectedEntityId;
        while (entities.size > maxEntities) {
            let victim = null;
            let victimDegree = Infinity;
            for (const e of entities.values()) {
                if (e.entityId === effectiveProtected) continue;
                const degree = relationDegree(e.entityId);
                if (!victim || degree < victimDegree ||
                    (degree === victimDegree && e.lastSeenAt < victim.lastSeenAt)) {
                    victim = e;
                    victimDegree = degree;
                }
            }
            if (!victim) break;
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
        // Bug review independen (audit putaran-60, OpenCode, W7R60-P2-2):
        // sibling PERSIS dari W7R60-P2-1 -- kapasitas 0 dengan
        // `protectedRelationId` sebagai satu-satunya relasi tidak pernah
        // dievict. Proteksi dilepas pada kapasitas 0.
        const maxRelations = Math.max(0, Math.trunc(bounds.MAX_RELATIONS));
        // Bug review independen (audit putaran-61, Codex, AUD61-P2-1,
        // BLOCKING, kelas umum): sibling PERSIS -- dilooping sampai
        // benar-benar patuh, bukan cuma satu korban per panggilan.
        const effectiveProtected = maxRelations === 0 ? null : protectedRelationId;
        while (relations.size > maxRelations) {
            let victim = null;
            for (const r of relations.values()) {
                if (r.relationId === effectiveProtected) continue;
                if (!victim || r.strength < victim.strength) victim = r;
            }
            if (!victim) break;
            relations.delete(victim.relationId);
            decDegree(victim.from);
            decDegree(victim.to);
        }
    }

    function declareEntity(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan destructuring jadi TypeError mentah alih-alih
        // INVALID_RECORD (pola yang sama dengan 11 titik masuk lain di
        // ke-4 lane pada putaran ini).
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec || {}`
        // aman untuk null/undefined, TAPI sebuah Proxy yang di-revoke tetap
        // truthy/typeof "object" -- destructuring di bawah tetap [[Get]]
        // MENTAH terhadapnya, keluar dari API publik ini sebagai TypeError
        // tak terkendali, bukan INVALID_RECORD.
        let entityId, entityKind, labels, externalRefs, source;
        try {
            ({ entityId, entityKind, labels, externalRefs, source } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        const existing = entities.get(entityId);
        // Bug diketemukan review independen (Codex): deklarasi ulang dengan
        // `source` BERBEDA dulu menimpa entitas tanpa menyesuaikan hitungan
        // kuota sumber lama/baru — celah untuk melampaui MAX_ENTITIES_PER_SOURCE.
        const isSourceChange = existing && existing.source !== source;
        const count = entityCountBySource.get(source) ?? 0;
        if ((!existing || isSourceChange) && count >= bounds.MAX_ENTITIES_PER_SOURCE) {
            fail(REASONS.QUOTA_EXCEEDED, `sumber '${source}' melebihi kuota entitas (WM-A6)`);
        }
        // Bug review independen (audit putaran-66, Codex, W7R66-P2-2):
        // `bounds` (sudah disanitasi) diteruskan eksplisit.
        const entity = makeEntity({ entityId, entityKind, labels, externalRefs, source, nowMs: now(), bounds });
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
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.relationId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-30, AUD30-P2-1; putaran-35,
        // AUD35-ADV-2): `spec.relationId` dulu dibaca sekali ke lokal untuk
        // cek tabrakan, tapi `{...spec}` di bawah masih men-spread `spec`
        // ITU SENDIRI (bukan sisa tanpa relationId) -- spread itu sendiri
        // membaca getter lagi (override eksplisit `relationId` sesudahnya
        // cuma membuang hasil baca kedua itu). Dikeluarkan lewat
        // destructuring supaya spread tidak menyentuhnya lagi.
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec` sudah
        // dijaga BUKAN null/non-objek DI ATAS, tapi sebuah Proxy yang
        // di-revoke tetap typeof "object" -- destructuring ini tetap
        // [[Get]] MENTAH terhadapnya.
        let relationId, specRest;
        try {
            ({ relationId, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-19, AUD19-A3): sapuan dedup
        // replay id putaran-9/10/13 mencakup observationId/declarationId/
        // hypothesisId/goalId/dll, tapi tidak pernah mencakup relationId --
        // replay sebuah relationId yang sudah ada diam-diam menimpa
        // topologi/strength relasi tersimpan.
        if (relationId && relations.has(relationId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `relationId '${typeof relationId === "string" ? relationId : typeof relationId}' sudah ada`);
        }
        const relation = makeRelation({ ...specRest, relationId });
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
        // Bug review independen (audit putaran-35, AUD35-P2-5): subjectKeyOf/
        // beliefKey dulu membaca `record.subject` lewat akses properti biasa
        // (trap `get` untuk Proxy), sementara applyRevision (di bawah)
        // mengambil subjek TERSIMPAN lewat buildSafeBeliefValue (trap
        // `getOwnPropertyDescriptor`) -- Proxy yang membuat kedua trap itu
        // tidak konsisten (get -> "e1", descriptor -> "e2") membuat kunci
        // belief dan subjek tersimpan menunjuk ke ENTITAS BERBEDA;
        // reconcileBeliefContradictionPointer lalu gagal menemukan belief-nya
        // sendiri pasca-RESOLVE, membuat query() melapor contested:true
        // selamanya. Disaring SEKALI di sini SEBELUM kunci dihitung; subjek
        // sanitasi yang sama (bukan Proxy asli lagi) dipakai untuk kunci
        // MAUPUN diteruskan ke applyRevision (yang boleh menyaringnya lagi
        // dengan aman -- objek polos, tidak ada lagi trap untuk berbeda).
        const safeSubject = buildSafeBeliefValue(record.subject);
        const subjectKey = subjectKeyOf(safeSubject);
        const key = beliefKey(safeSubject, record.attribute);
        const existing = beliefs.get(key);

        // Bug review independen (audit putaran-14, AUD14-P1-2): kompaksi
        // (menghapus belief valid lain) dulu berjalan SEBELUM applyRevision
        // -- satu-satunya tempat record.value/subject benar-benar disaring
        // (buildSafeBeliefValue) -- sehingga sebuah observasi/deklarasi yang
        // DITOLAK (mis. BigInt pada value) tetap mengevict satu belief VALID
        // sebelum error dilempar, kehilangan data permanen. applyRevision
        // sekarang dipanggil DULU; kompaksi hanya terjadi setelah belief
        // yang akan disimpan terbukti valid.
        // Bug review independen (audit putaran-64, Codex, AUD64-P2-1,
        // sibling sweep): `bounds` (sudah disanitasi) diteruskan eksplisit.
        const { case: caseName, belief, contradiction } = applyRevision({
            existing, record: { ...record, subject: safeSubject, subjectKey }, nowMs: now(), decayPolicy: DEFAULT_DECAY_POLICY, bounds
        });

        // Bug review independen (audit putaran-7, W7R7-P1-3): beliefs tidak
        // punya batas total sama sekali -- attribute string bebas milik
        // pemanggil (ingestObservation/ingestDeclaration) berarti satu
        // entitas bisa memicu beliefs tak terbatas. Cek HANYA saat key ini
        // BARU (existing null) supaya tidak pernah mengevict belief yang
        // baru saja dibuat/direvisi di panggilan ini sendiri.
        // Bug ditemukan lewat sapuan mandiri (setelah audit putaran-59):
        // sibling PERSIS dari kelas W7R59-P2-1..5 -- kapasitas 0 (sanksi
        // sah lewat sanitizeBounds) dengan `beliefs` kosong membuat
        // `victimKey` tetap null (tidak ada korban), tapi belief baru
        // tetap disimpan tanpa syarat di `beliefs.set(key, belief)` di
        // bawah, melampaui cap total secara diam-diam. Kapasitas 0
        // berarti TIDAK ADA belief baru yang dipertahankan.
        // Bug review independen (audit putaran-61, Codex, AUD61-P2-1,
        // BLOCKING, kelas umum): dilooping sampai populasi (SETELAH
        // menghitung belief baru yang akan ditambahkan) benar-benar patuh
        // ke bound saat ini -- bukan cuma satu korban per panggilan, yang
        // gagal mengompaksi kalau store dimuat ulang dengan bound lebih
        // rendah dari saat data itu dipersist.
        const maxTotalBeliefs = Math.max(0, Math.trunc(bounds.MAX_TOTAL_BELIEFS));
        let skipNewBeliefStorage = false;
        if (!existing) {
            while (beliefs.size >= maxTotalBeliefs) {
                let victimKey = null, victimUpdatedAtMs = Infinity;
                for (const [k, b] of beliefs) {
                    if (b.updatedAtMs < victimUpdatedAtMs) { victimUpdatedAtMs = b.updatedAtMs; victimKey = k; }
                }
                if (victimKey === null) { skipNewBeliefStorage = (maxTotalBeliefs === 0); break; }
                beliefs.delete(victimKey);
            }
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
                // Bug review independen (audit putaran-24, AUD24-P2-1): entri
                // yang dilempar dari `contradictions` (dan yang lalu ikut
                // dilempar lagi dari `overflowedContradictions` saat arsip
                // itu SENDIRI overflow) tidak pernah mencocokkan kembali
                // belief yang contradictionSetId-nya menunjuk ke entri itu --
                // query() bisa terus melapor contested:true dengan id yang
                // sudah tidak ada di collection manapun, dan resolveContradiction()
                // atas id itu melempar UNKNOWN_ENTITY. Dicocokkan ulang di
                // KEDUA titik pelemparan (round-23's "other OPEN sets" logic
                // yang sama, dipakai ulang di sini).
                reconcileBeliefContradictionPointer(evicted);
                overflowedContradictions.push(evicted);
                if (overflowedContradictions.length > bounds.MAX_OPEN_CONTRADICTION_SETS) {
                    const droppedFromArchive = overflowedContradictions.shift();
                    reconcileBeliefContradictionPointer(droppedFromArchive);
                }
            }
            const nextContestedRecordIds = Object.freeze(appendBounded(
                existing.contestedRecordIds ?? [], contradiction.challengerRecordId,
                bounds.MAX_OPEN_CONTRADICTION_SETS));
            // Bug review independen (audit putaran-60, Codex, W7R60-P2-2):
            // round-59's kapasitas-0 fix untuk openContradictionSet
            // mengembalikan `entry` yang SUDAH diarsipkan (status bukan
            // "OPEN", entry === evicted) alih-alih pernah benar-benar
            // terbuka -- sebelumnya tetap dipasang sebagai
            // contradictionSetId/contested:true belief, membocorkan
            // pointer ke contradiction set yang tidak ada di manapun
            // (openContradictions() kosong tapi query() melapor contested).
            // Entry yang langsung diarsipkan tidak boleh menandai belief
            // sebagai kontes AKTIF; contradictionSetId lama (kalau ada)
            // dipertahankan apa adanya.
            const isActiveContradiction = entry.status === "OPEN";
            const contested = Object.freeze({
                ...existing,
                contradictionSetId: isActiveContradiction ? entry.contradictionSetId : (existing.contradictionSetId ?? null),
                contestedRecordIds: nextContestedRecordIds
            });
            beliefs.set(key, contested);
            return { case: caseName, belief: contested, contradictionSetId: isActiveContradiction ? entry.contradictionSetId : null };
        }

        if (!skipNewBeliefStorage) beliefs.set(key, belief);
        return { case: caseName, belief, contradictionSetId: null };
    }

    function ingestObservation(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.observationId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-35, AUD35-ADV-2): `spec.observationId`
        // dulu dibaca lewat `spec.observationId ?? crypto.randomUUID()` DI
        // DALAM object literal yang juga men-spread `...spec` -- sisa kunci
        // itu (yang masih punya observationId) DAN akses langsung sama-sama
        // membaca getter yang sama, dua kali. Dikeluarkan lewat destructuring.
        // Bug review independen (audit putaran-44, W7R44-P2-2): sibling
        // langsung dari declareRelation/declareHypothesis di file yang
        // SAMA -- Proxy yang di-revoke tetap typeof "object", lolos guard
        // di atas, lalu raw-throw di destructuring ini.
        let observationId, specRest;
        try {
            ({ observationId, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-67, sapuan preventif):
        // `bounds` diteruskan eksplisit, sesudah spread.
        const observation = makeObservation({ ...specRest, observationId: observationId ?? crypto.randomUUID(), bounds });
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
    function ingestDeclaration(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan destructuring jadi TypeError mentah.
        // Bug review independen (audit putaran-44, W7R44-P2-2): `spec || {}`
        // tidak melindungi dari Proxy yang di-revoke (tetap truthy/typeof
        // "object") -- destructuring ini tetap [[Get]] mentah.
        let subject, attribute, value, declarationId, at;
        try {
            ({ subject, attribute, value, declarationId, at } = spec || {});
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        // Bug review independen (audit putaran-36, AUD36-P2-1): round-35
        // (AUD35-P2-5) menyatukan kunci belief dan subjek TERSIMPAN supaya
        // keduanya berasal dari SATU pembacaan (buildSafeBeliefValue, trap
        // `getOwnPropertyDescriptor`) -- tapi guard bentuk subjek DI SINI
        // masih membaca `subject.entityId`/`.relationId` lewat [[Get]] biasa
        // (trap `get`). Proxy yang membuat kedua trap tidak konsisten
        // (get -> "e1" valid, descriptor -> 42 tidak valid) melewati guard
        // ini dengan subjek yang TERLIHAT sah, padahal bentuk yang BENAR-
        // BENAR akan tersimpan (descriptor) tidak sah -- deklarasi diterima
        // lalu jatuh ke kunci sentinel "invalid:malformed-subject", bisa
        // bertabrakan/CONTEST palsu dengan subjek lain yang juga malformed.
        // Disaring SEKALI di sini; guard DAN applyRecordToBelief (yang
        // menyaring ulang -- aman, objek polos tidak lagi punya trap)
        // memakai bentuk tersanitasi yang SAMA.
        const safeSubject = buildSafeBeliefValue(subject);
        if (!safeSubject || (typeof safeSubject.entityId !== "string" && typeof safeSubject.relationId !== "string")) {
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
            recordId: declarationId ?? crypto.randomUUID(), subject: safeSubject, attribute, value,
            tier: "DECLARED", observedAt: at ?? nowIso(), observedAtMs: now()
        });
    }

    function declareHypothesis(spec) {
        // Bug review independen (audit putaran-22, F-4): spec null/non-objek
        // meledakkan `spec.hypothesisId` jadi TypeError mentah.
        if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec wajib objek");
        // Bug review independen (audit putaran-13, AUD13-P2-4): hypothesisId
        // tidak pernah dicek tabrakan -- replay sebuah hypothesisId yang
        // sudah ada diam-diam menimpa candidateValues/expiresAt tersimpan,
        // pola yang sama yang sudah ditutup untuk observationId/
        // declarationId (putaran 9) dan id goals/prospective (putaran 10)
        // tapi tidak pernah dimigrasikan ke worldmodel's hypothesisId.
        // Bug review independen (audit putaran-30, AUD30-P2-1; putaran-35,
        // AUD35-ADV-2): `spec.hypothesisId` dulu dibaca sekali ke lokal
        // untuk cek tabrakan, tapi `{...spec}` di bawah masih men-spread
        // `spec` ITU SENDIRI -- spread itu sendiri membaca getter lagi.
        // Dikeluarkan lewat destructuring.
        // Bug review independen (audit putaran-44, W7R44-P2-2): sibling
        // dari declareRelation/ingestObservation di file yang sama.
        let hypothesisId, specRest;
        try {
            ({ hypothesisId, ...specRest } = spec);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (hypothesisId && hypotheses.has(hypothesisId)) {
            fail(REASONS.DUPLICATE_RECORD_ID, `hypothesisId '${typeof hypothesisId === "string" ? hypothesisId : typeof hypothesisId}' sudah ada`);
        }
        // Bug review independen (audit putaran-14, AUD14-P1-2): kompaksi
        // (menghapus hipotesis valid lain) dulu berjalan SEBELUM
        // makeHypothesis memvalidasi spec -- spec yang ditolak (mis.
        // expiresAt cacat) tetap mengevict satu hipotesis VALID sebelum
        // error dilempar, kehilangan data permanen. Validasi/bangun record
        // DULU, baru kompaksi+simpan.
        // Bug review independen (audit putaran-66, Codex, W7R66-P2-2):
        // `bounds` (sudah disanitasi) diteruskan eksplisit, SESUDAH spread.
        const h = makeHypothesis({ ...specRest, hypothesisId, bounds });
        // Bug ditemukan lewat sapuan mandiri (setelah audit putaran-59):
        // sibling PERSIS dari kelas W7R59-P2-1..5 -- kapasitas 0 (sanksi
        // sah lewat sanitizeBounds) dengan `hypotheses` kosong membuat
        // `sorted[0]` undefined (tidak ada korban), tapi `hypotheses.set`
        // di bawah tetap tanpa syarat, melampaui cap total secara diam-
        // diam. Kapasitas 0 berarti TIDAK ADA hipotesis baru yang
        // dipertahankan.
        // Bug review independen (audit putaran-61, Codex, AUD61-P2-1,
        // BLOCKING, kelas umum): dilooping sampai benar-benar patuh.
        const maxHypotheses = Math.max(0, Math.trunc(bounds.MAX_HYPOTHESES));
        let skipNewHypothesisStorage = false;
        while (hypotheses.size >= maxHypotheses) {
            // §11: kadaluwarsa dulu, lalu bobot terendah.
            const sorted = [...hypotheses.values()].sort((a, b) =>
                (Date.parse(a.expiresAt) - Date.parse(b.expiresAt)));
            if (!sorted[0]) { skipNewHypothesisStorage = (maxHypotheses === 0); break; }
            hypotheses.delete(sorted[0].hypothesisId);
        }
        if (!skipNewHypothesisStorage) hypotheses.set(h.hypothesisId, h);
        return h;
    }

    function query(spec) {
        // Bug review independen (audit putaran-22, F-3): AUD21-ADV-1 menjaga
        // `subject` malformed lewat subjectKeyOf, tapi `spec` itu sendiri
        // null/undefined tetap meledakkan destructuring `{subject,...}` di
        // queryBelief SEBELUM subjectKeyOf sempat dipanggil -- perbaikan
        // tidak lengkap untuk kasus paling jelas.
        if (!spec || typeof spec !== "object") {
            return { unknown: true, reason: "NEVER_OBSERVED", lastKnown: null };
        }
        // Bug review independen (audit putaran-44, W7R44-P2-2): `typeof
        // spec !== "object"` TIDAK menangkap Proxy yang di-revoke (tetap
        // typeof "object") -- destructuring parameter queryBelief
        // (`{subject, attribute, ...}`) raw-throw terhadapnya. query()
        // TIDAK PERNAH melempar untuk input malformed (kontraknya selalu
        // mengembalikan `{unknown:true,...}`) -- disamakan di sini juga.
        try {
            return queryBelief(beliefs, spec, now());
        } catch {
            return { unknown: true, reason: "NEVER_OBSERVED", lastKnown: null };
        }
    }

    function openContradictions() { return contradictions.filter(c => c.status === "OPEN"); }
    /** AUD16-P2-2: kontradiksi yang belum terselesaikan (status masih OPEN saat overflow) yang terdorong keluar dari daftar terbatas. */
    function overflowedContradictionsView() { return [...overflowedContradictions]; }

    // Bug review independen (audit putaran-22, A-1; diperbaiki putaran-23,
    // AUD23-P1-1; diperluas putaran-24, AUD24-P2-1): belief.contradictionSetId
    // hanya pernah menyimpan SATU set (yang terbaru), tapi bisa ada >1 set
    // OPEN untuk beliefKey yang sama. Setiap kali satu set BERHENTI eksis
    // di `contradictions` (di-resolve, ATAU dilempar keluar oleh overflow
    // `contradictions` sendiri, ATAU dilempar keluar oleh overflow arsip
    // `overflowedContradictions`), belief yang menunjuk ke set itu wajib
    // dicocokkan ulang ke satu-satunya sumber kebenaran (`contradictions`
    // yang OPEN) -- bukan dibiarkan menunjuk ke id yang sudah tidak ada di
    // collection manapun (query() lalu melaporkan contested:true dengan id
    // yang resolveContradiction() sendiri tolak sebagai UNKNOWN_ENTITY).
    function reconcileBeliefContradictionPointer(goneEntry) {
        if (!goneEntry) return;
        const key = beliefKey(goneEntry.subject, goneEntry.attribute);
        const belief = beliefs.get(key);
        if (!belief || belief.contradictionSetId !== goneEntry.contradictionSetId) return;
        const stillOpen = contradictions.filter(c =>
            c.status === "OPEN" && c.contradictionSetId !== goneEntry.contradictionSetId &&
            beliefKey(c.subject, c.attribute) === key);
        const nextContradictionSetId = stillOpen.length > 0
            ? stillOpen[stillOpen.length - 1].contradictionSetId
            : null;
        beliefs.set(key, Object.freeze({ ...belief, contradictionSetId: nextContradictionSetId }));
    }

    function resolveContradiction(contradictionSetId, ruleId) {
        contradictions = resolveContradictionSet(contradictions, contradictionSetId, ruleId, nowIso());
        const entry = contradictions.find(c => c.contradictionSetId === contradictionSetId);
        if (entry) reconcileBeliefContradictionPointer(entry);
        return entry;
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
        // Bug review independen (audit putaran-64, Codex, AUD64-P2-1):
        // `bounds` (sudah disanitasi lewat sanitizeBounds) diteruskan
        // eksplisit di sini -- sebelumnya graphOps membaca BOUNDS modul
        // TETAP sendiri, mengabaikan override per-instance sepenuhnya.
        neighbors: (id, kinds, depth = 1) => graphOps.neighbors(stateView(), id, kinds, depth, bounds),
        subgraph: (seeds, depth, budget) => graphOps.subgraph(stateView(), seeds, depth, budget, bounds),
        path: (from, to, maxDepth) => graphOps.path(stateView(), from, to, maxDepth, bounds),
        entitiesByKind: (kind, limit) => graphOps.entitiesByKind(stateView(), kind, limit, bounds),
        openContradictions, overflowedContradictions: overflowedContradictionsView, resolveContradiction, entityCountBySourceSize, beliefsSize,
        persist, laws, bounds
    });
}

module.exports = { createWorldModel, laws, BOUNDS };
