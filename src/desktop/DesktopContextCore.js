/**
 * DESKTOP CONTEXT CORE — keadaan semantik desktop yang kanonik.
 *
 * Aturan main:
 *
 * 1. ATOMIS (B2): satu observasi = satu transisi keadaan. Seluruh
 *    efek dihitung pada SALINAN state (stage) dan dikomit sekali di
 *    akhir. Observasi ditolak → NOL mutasi, NOL versi, NOL transisi.
 *    Atribut tidak-JSON-safe / bersiklus / oversize ditolak, tidak
 *    pernah masuk state kanonik.
 * 2. URUTAN KONVERGEN (B3): canonical winner entitas dan pointer
 *    aktif dipilih dengan total order deterministik
 *    (timestamp → confidence → adapterId → observationId).
 *    Observasi basa yang datang terlambat TIDAK menimpa state baru.
 *    Set observasi sama dengan urutan tiba berbeda konvergen ke
 *    snapshot identik (entitas terurut id, relasi terurut kunci,
 *    riwayat terurut kunci waktu, revision = hitungan observasi).
 * 3. PROVENANCE TERPERCAYA (B5): provenance kanonik dicap core dari
 *    registrasi adapter (`adapter:<id>`); klaim provenance dari
 *    payload disimpan terpisah sebagai claimedProvenance. Adapter
 *    hanya boleh mengirim kelas event sesuai kapabilitas terdaftar.
 * 4. INVALIDASI TERIKAT LINGKUP (B6): penggantian dokumen/seleksi
 *    hanya terjadi dalam lingkup jendela yang dihubungkan SECARA
 *    EKSPLISIT oleh relasi (displayed_in/selected_in). Tanpa
 *    lingkup → tidak menyentuh state jendela lain. Staleness lazim
 *    (diturunkan dari ledger pemenang), bukan penanda eager —
 *    sehingga urutan kedatangan tidak mengubah hasil.
 * 5. VIEW TERDETACH (B7): tidak ada accessor yang membocorkan
 *    referensi mutable; getView() mengembalikan salinan beku.
 * 6. BERBATAS (B8): entitas, entitas basi, relasi, ID dedupe
 *    (LRU), atribut (byte), dan snapshot punya batas terpusat dengan
 *    eviksi deterministik + indeks relasi agar resolusi tanpa full
 *    scan tak terbatas.
 * 7. REFERENSI RANTING GAGAL (B9): subject harus ada/dibuat dalam
 *    observasi yang sama; endpoint relasi harus resolve; tipe
 *    subject harus cocok semantik event. accepted:true berarti efek
 *    kanonik benar-benar diterapkan.
 *
 * Substrate ini memberi NOL otoritas actuation: tidak ada metode
 * eksekusi/kontrol apa pun di sini.
 */

const crypto = require("node:crypto");
const ContextEntity = require("./ContextEntity");
const Observation = require("./ContextObservation");
const Snapshot = require("./ContextSnapshot");
const { stableStringify } = require("./StableJson");
const {
    DESKTOP_EVENT,
    EVENT_TO_TRANSITION,
    RELATIONSHIP,
    ENTITY_TYPE,
    CAPABILITY_EVENTS,
    SUBJECT_ALLOWED_TYPES,
    SCHEMA_VERSION
} = require("./types");

const CHILD_RELATIONS = new Set([
    RELATIONSHIP.DISPLAYED_IN,
    RELATIONSHIP.SELECTED_IN,
    RELATIONSHIP.VISUAL_OF,
    RELATIONSHIP.BELONGS_TO
]);

/** Relasi yang mengikat entitas pada lingkup jendelanya (B6). */
const SCOPE_RELATIONS = {
    [ENTITY_TYPE.DOCUMENT]: RELATIONSHIP.DISPLAYED_IN,
    [ENTITY_TYPE.TERMINAL]: RELATIONSHIP.DISPLAYED_IN,
    [ENTITY_TYPE.TEXT_SELECTION]: RELATIONSHIP.SELECTED_IN
};

const DEFAULT_LIMITS = Object.freeze({
    maxHistory: 50,
    maxLiveEntities: 400,
    maxStaleRetained: 200,
    maxRelationships: 1200,
    maxDedupeIds: 1024,
    maxAttributeBytes: 2048,
    maxLabelChars: 512,
    maxSnapshotBytes: 65536
});

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Pembanding kunci aktivasi {at, observationId}. */
function cmpKey(a, b) {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
}

/**
 * Total order kanonik antar versi observasi entitas (B3):
 * timestamp → confidence → adapterId → observationId.
 */
function cmpCanonical(a, b) {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.confidence !== b.confidence) return a.confidence < b.confidence ? -1 : 1;
    if (a.adapter !== b.adapter) return a.adapter < b.adapter ? -1 : 1;
    if (a.observationId !== b.observationId) return a.observationId < b.observationId ? -1 : 1;
    return 0;
}

class DesktopContextCore {

    constructor(options = {}) {
        this.#clock = typeof options.clock === "function" ? options.clock : (() => Date.now());

        this.#limits = Object.freeze({
            maxHistory: clampInt(options.maxHistory, 1, 5000, DEFAULT_LIMITS.maxHistory),
            maxLiveEntities: clampInt(options.maxLiveEntities, 10, 100000, DEFAULT_LIMITS.maxLiveEntities),
            maxStaleRetained: clampInt(options.maxStaleRetained, 0, 100000, DEFAULT_LIMITS.maxStaleRetained),
            maxRelationships: clampInt(options.maxRelationships, 10, 500000, DEFAULT_LIMITS.maxRelationships),
            maxDedupeIds: clampInt(options.maxDedupeIds, 10, 1000000, DEFAULT_LIMITS.maxDedupeIds),
            maxAttributeBytes: clampInt(options.maxAttributeBytes, 64, 1048576, DEFAULT_LIMITS.maxAttributeBytes),
            maxLabelChars: clampInt(options.maxLabelChars, 16, 65536, DEFAULT_LIMITS.maxLabelChars),
            maxSnapshotBytes: clampInt(options.maxSnapshotBytes, 1024, 16777216, DEFAULT_LIMITS.maxSnapshotBytes)
        });
    }

    // ---- adapter registration ------------------------------------------

    /** Hanya adapter terdaftar yang boleh mengubah keadaan kanonik. */
    registerAdapter({ adapterId, trusted = true, capabilities = [] }) {
        if (typeof adapterId !== "string" || !adapterId) {
            throw new Error("registerAdapter butuh adapterId string.");
        }
        const events = new Set();
        for (const cap of capabilities) {
            const allowed = CAPABILITY_EVENTS[cap];
            if (!allowed) {
                throw new Error(`kapabilitas tidak dikenal: ${cap}`);
            }
            for (const evt of allowed) events.add(evt);
        }
        this.#adapters.set(adapterId, { trusted: trusted !== false, events });
        return this;
    }

    isAdapterRegistered(adapterId) {
        return this.#adapters.has(adapterId);
    }

    // ---- ingest (satu-satunya jalur mutasi; atomik) ---------------------

    ingest(raw) {

        const check = Observation.validate(raw);
        if (!check.ok) {
            return this.#diagnose(check.reasonCode, check.detail, raw?.observationId ?? null);
        }
        const obs = check.value;

        const reg = this.#adapters.get(obs.source.adapterId);
        if (!reg || !reg.trusted) {
            return this.#diagnose("REJECTED_UNTRUSTED_SOURCE",
                `adapter '${obs.source.adapterId}' tidak terdaftar/tepercaya`,
                obs.observationId);
        }

        if (!reg.events.has(obs.type)) {
            return this.#diagnose("REJECTED_CAPABILITY",
                `adapter '${obs.source.adapterId}' tidak mendeklarasikan event ${obs.type}`,
                obs.observationId);
        }

        let digest;
        try {
            digest = stableStringify({
                type: obs.type,
                timestamp: obs.timestamp,
                source: obs.source,
                subject: obs.subject,
                entities: obs.entities,
                relationships: obs.relationships,
                payload: obs.payload
            });
        } catch (err) {
            return this.#diagnose("ATTRIBUTES_NOT_SERIALIZABLE",
                `observasi tidak dapat diserialisasi stabil: ${err.message}`,
                obs.observationId);
        }

        const prevDigest = this.#seen.get(obs.observationId);
        if (prevDigest !== undefined) {
            if (prevDigest === digest) {
                return this.#diagnose("DUPLICATE_OBSERVATION",
                    "observasi identik sudah diproses (idempoten)", obs.observationId);
            }
            return this.#diagnose("CONFLICTING_OBSERVATION",
                "observationId sama dengan payload berbeda", obs.observationId);
        }

        let staged;
        try {
            staged = this.#stage(obs, reg);
        } catch (err) {
            // Getter melempar / cacat tak terduga → NOL mutasi.
            return this.#diagnose(err?.code === "STAGE_REJECT" ? err.reasonCode : "INGEST_COMPUTE_FAILED",
                String(err?.detail ?? err?.message ?? err), obs.observationId);
        }

        if (!staged.ok) {
            return this.#diagnose(staged.reasonCode, staged.detail, obs.observationId);
        }

        // COMMIT tunggal — tidak ada jalur gagal lagi setelah titik ini.
        this.#entities = staged.entities;
        this.#meta = staged.meta;
        this.#counts = staged.counts;
        this.#relByKey = staged.relByKey;
        this.#idxFrom = staged.idxFrom;
        this.#idxTo = staged.idxTo;
        this.#globalWinners = staged.globalWinners;
        this.#scopedWinners = staged.scopedWinners;
        this.#dead = staged.dead;
        this.#lastClear = staged.lastClear;
        this.#history = staged.history;
        this.#historyTruncated = staged.historyTruncated;

        this.#seen.set(obs.observationId, digest);
        while (this.#seen.size > this.#limits.maxDedupeIds) {
            const oldest = this.#seen.keys().next().value;
            this.#seen.delete(oldest);
        }

        this.#version += 1;
        return { accepted: true, reasonCode: "ACCEPTED", observationId: obs.observationId };
    }

    // ------------------------------------------------------------------
    // STAGE — seluruh keputusan pada salinan; gagal = buang semuanya.
    // ------------------------------------------------------------------

    #stage(obs, reg) {

        const s = {
            entities: new Map(this.#entities),
            meta: new Map(this.#meta),
            counts: new Map(this.#counts),
            relByKey: new Map(this.#relByKey),
            idxFrom: new Map([...this.#idxFrom].map(([k, v]) => [k, new Set(v)])),
            idxTo: new Map([...this.#idxTo].map(([k, v]) => [k, new Set(v)])),
            globalWinners: new Map(this.#globalWinners),
            scopedWinners: new Map(this.#scopedWinners),
            dead: new Map(this.#dead),
            lastClear: this.#lastClear,
            history: [...this.#history],
            historyTruncated: this.#historyTruncated,
            ok: false
        };

        const fail = (reasonCode, detail) =>
            ({ ok: false, reasonCode, detail });

        // -- 1. validasi atribut (JSON-safe + ukuran) --------------------
        const specs = [];
        for (const e of obs.entities) {
            let attrJson;
            try {
                attrJson = stableStringify(e.attributes ?? {});
            } catch (err) {
                return fail("ATTRIBUTES_NOT_SERIALIZABLE",
                    `atribut entitas '${e.id}' tidak JSON-safe: ${err.message}`);
            }
            if (Buffer.byteLength(attrJson, "utf8") > this.#limits.maxAttributeBytes) {
                return fail("ATTRIBUTES_TOO_LARGE",
                    `atribut entitas '${e.id}' melebihi ${this.#limits.maxAttributeBytes} byte`);
            }
            specs.push({
                ...e,
                label: e.label.length > this.#limits.maxLabelChars
                    ? e.label.slice(0, this.#limits.maxLabelChars)
                    : e.label
            });
        }

        const declared = new Set();
        for (const spec of specs) declared.add(spec.id);
        for (const id of s.entities.keys()) declared.add(id);

        // -- 2. subject harus resolve + tipe cocok semantik event (B9) ---
        if (obs.subject != null) {
            if (!declared.has(obs.subject)) {
                return fail("UNRESOLVED_SUBJECT",
                    `subject '${obs.subject}' tidak ada dan tidak dibuat observasi ini`);
            }
            const allowed = SUBJECT_ALLOWED_TYPES[obs.type];
            if (allowed) {
                const t = specOf(s, specs, obs.subject)?.type;
                if (t && !allowed.includes(t)) {
                    return fail("INVALID_ACTIVE_TARGET",
                        `${obs.type} menuntut ${allowed.join("|")}, dapat '${t}'`);
                }
            }
        }

        // -- 3. endpoint relasi harus resolve (B9) ------------------------
        for (const r of obs.relationships) {
            if (!declared.has(r.from) || !declared.has(r.to)) {
                return fail("DANGLING_RELATIONSHIP",
                    `relasi ${r.from} -[${r.relation}]-> ${r.to} memiliki endpoint hantu`);
            }
        }

        // -- 4. terapkan entitas lewat total order kanonik (B3) ----------
        for (const spec of specs) {
            this.#considerEntity(s, spec, obs, reg);
        }

        // -- 5. terapkan relasi (dedupe by key + indeks) ------------------
        for (const r of obs.relationships) {
            const key = `${r.from}|${r.relation}|${r.to}`;
            if (!s.relByKey.has(key)) {
                s.relByKey.set(key, Object.freeze({ ...r }));
                addIndex(s.idxFrom, r.from, key);
                addIndex(s.idxTo, r.to, key);
            }
        }

        // -- 6. semantik event lewat ledger pemenang (B3/B6) --------------
        const k = { at: obs.timestamp, id: obs.observationId };

        switch (obs.type) {

            case DESKTOP_EVENT.APPLICATION_ACTIVATED:
                keepWinner(s.globalWinners, "application", k, obs.subject);
                break;

            case DESKTOP_EVENT.WINDOW_ACTIVATED: {
                keepWinner(s.globalWinners, "window", k, obs.subject);
                // Dokumen yang dibawa jendela ikut aktif dalam lingkup
                // jendela itu — HANYA jika observasinya menang komparator.
                const docSpec = specs.find((e) =>
                    e.type === ENTITY_TYPE.DOCUMENT || e.type === ENTITY_TYPE.TERMINAL);
                if (docSpec) {
                    keepWinner(s.scopedWinners, `doc:${obs.subject}`, k, docSpec.id);
                }
                break;
            }

            case DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED: {
                const scope = this.#scopeWindowOf(s, specs, obs.subject);
                if (scope) {
                    keepWinner(s.scopedWinners, `doc:${scope}`, k, obs.subject);
                } else {
                    // Tanpa lingkup eksplisit → TIDAK menyentuh dokumen
                    // jendela mana pun (B6); masuk kolom tak berlingkup.
                    keepWinner(s.globalWinners, "unscopedDoc", k, obs.subject);
                }
                break;
            }

            case DESKTOP_EVENT.SELECTION_CHANGED: {
                const scope = this.#scopeWindowOf(s, specs, obs.subject);
                if (scope) {
                    keepWinner(s.scopedWinners, `sel:${scope}`, k, obs.subject);
                } else {
                    keepWinner(s.globalWinners, "unscopedSel", k, obs.subject);
                }
                break;
            }

            case DESKTOP_EVENT.FILE_SELECTION_CHANGED:
                keepWinner(s.globalWinners, "fileSelection", k, obs.subject);
                break;

            case DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED:
                keepWinner(s.globalWinners, "visual", k, obs.subject);
                break;

            case DESKTOP_EVENT.WORKSPACE_CHANGED:
                keepWinner(s.globalWinners, "workspace", k, obs.subject);
                break;

            case DESKTOP_EVENT.CLIPBOARD_CHANGED:
                keepWinner(s.globalWinners, "clipboard", k, obs.subject);
                break;

            case DESKTOP_EVENT.WINDOW_CLOSED: {
                // Jendela + anak langsungnya mati eksplisit.
                s.dead.set(obs.subject, "WINDOW_CLOSED");
                const childKeys = s.idxTo.get(obs.subject) ?? new Set();
                for (const rk of childKeys) {
                    const rel = s.relByKey.get(rk);
                    if (rel && CHILD_RELATIONS.has(rel.relation) && !s.dead.has(rel.from)) {
                        s.dead.set(rel.from, "WINDOW_CLOSED");
                    }
                }
                // Ledger lingkup jendela ini hangus.
                s.scopedWinners.delete(`doc:${obs.subject}`);
                s.scopedWinners.delete(`sel:${obs.subject}`);
                break;
            }

            case DESKTOP_EVENT.CONTEXT_INVALIDATED:
                if (obs.subject == null) {
                    if (!s.lastClear || cmpKey(k, s.lastClear) > 0) s.lastClear = k;
                } else {
                    s.dead.set(obs.subject, "CONTEXT_CLEARED");
                }
                break;

            default:
                break;
        }

        // -- 7. riwayat terurut + berbatas (B3/B8) ------------------------
        const transitionType = EVENT_TO_TRANSITION[obs.type];
        if (transitionType) {
            const entry = {
                id: `tr-${obs.timestamp}-${obs.observationId}`,
                transitionType,
                at: obs.timestamp,
                observationId: obs.observationId,
                source: obs.source.adapterId,
                subjectIds: obs.subject ? [obs.subject] : []
            };
            const pos = findSortedPos(s.history, entry);
            s.history.splice(pos, 0, entry);
            while (s.history.length > this.#limits.maxHistory) {
                s.history.shift();           // kunci terkecil = terlama
                s.historyTruncated = true;
            }
        }

        // -- 8. batas relasi (eviksi kunci terkecil, deterministik) -------
        while (s.relByKey.size > this.#limits.maxRelationships) {
            let minKey = null;
            for (const key of s.relByKey.keys()) {
                if (minKey === null || key < minKey) minKey = key;
            }
            this.#removeRelationship(s, minKey);
        }

        // -- 9. batas entitas (B8): basi dulu, terlama dulu, lindungi -----
        //      subjek ledger aktif.
        const entityCap = this.#limits.maxLiveEntities + this.#limits.maxStaleRetained;
        if (s.entities.size > entityCap) {
            const protectedIds = new Set();
            for (const [, entry] of s.globalWinners) protectedIds.add(entry.subjectId);
            for (const [, entry] of s.scopedWinners) protectedIds.add(entry.subjectId);

            while (s.entities.size > entityCap) {
                let victim = null;
                for (const [id, e] of s.entities) {
                    if (protectedIds.has(id)) continue;
                    const rankKey = `${s.dead.has(id) ? 0 : 1}|${e.observedAt ?? 0}|${id}`;
                    if (!victim || rankKey < victim.rankKey) {
                        victim = { id, rankKey };
                    }
                }
                if (!victim) break;          // semua terlindungi → biarkan
                this.#evictEntity(s, victim.id);
            }
        }

        return { ...s, ok: true };
    }

    // ---- penerapan entitas kanonik (B3) ---------------------------------

    #considerEntity(s, spec, obs, reg) {
        const count = (s.counts.get(spec.id) ?? 0) + 1;
        s.counts.set(spec.id, count);

        const candidateMeta = {
            at: obs.timestamp,
            confidence: spec.confidence,
            adapter: obs.source.adapterId,
            observationId: obs.observationId
        };
        const candidate = ContextEntity.create({
            id: spec.id,
            type: spec.type,
            label: spec.label,
            attributes: spec.attributes,
            confidence: spec.confidence,
            // FAKTA TERPERCAYA: identitas registrasi, bukan klaim payload.
            provenance: `adapter:${obs.source.adapterId}`,
            claimedProvenance: spec.claimedProvenance,
            observedAt: obs.timestamp,
            revision: count
        });

        const prev = s.entities.get(spec.id);
        if (!prev) {
            s.entities.set(spec.id, candidate);
            s.meta.set(spec.id, candidateMeta);
            return;
        }

        const c = cmpCanonical(candidateMeta, s.meta.get(spec.id));
        if (c > 0) {
            s.entities.set(spec.id, candidate);
            s.meta.set(spec.id, candidateMeta);
        } else if (c < 0) {
            // Observasi basa: state kanonik bertahan, revisi tetap
            // mencerminkan jumlah observasi yang diterima (konvergen).
            s.entities.set(spec.id, ContextEntity.withRevision(prev, count));
        }
    }

    // ---- util struktur ---------------------------------------------------

    #scopeWindowOf(s, specs, entityId) {
        const type = specOf(s, specs, entityId)?.type;
        const wanted = SCOPE_RELATIONS[type];
        if (!wanted) return null;
        for (const rk of (s.idxFrom.get(entityId) ?? [])) {
            const rel = s.relByKey.get(rk);
            if (!rel || rel.relation !== wanted) continue;
            const target = s.entities.get(rel.to);
            if (target?.type === ENTITY_TYPE.WINDOW) return rel.to;
        }
        return null;
    }

    #removeRelationship(s, key) {
        const rel = s.relByKey.get(key);
        if (!rel) return;
        s.relByKey.delete(key);
        s.idxFrom.get(rel.from)?.delete(key);
        s.idxTo.get(rel.to)?.delete(key);
    }

    #evictEntity(s, id) {
        s.entities.delete(id);
        s.meta.delete(id);
        s.counts.delete(id);
        s.dead.delete(id);
        for (const key of [...(s.idxFrom.get(id) ?? [])]) this.#removeRelationship(s, key);
        for (const key of [...(s.idxTo.get(id) ?? [])]) this.#removeRelationship(s, key);
        for (const [kind, entry] of [...s.globalWinners]) {
            if (entry.subjectId === id) s.globalWinners.delete(kind);
        }
        for (const [scope, entry] of [...s.scopedWinners]) {
            if (entry.subjectId === id) s.scopedWinners.delete(scope);
        }
    }

    // ---- liveness lazim (B3/B6) ------------------------------------------

    #entryEffective(s, entry) {
        if (!entry) return null;
        if (s.lastClear && cmpKey(entry.key, s.lastClear) <= 0) return null;
        return entry;
    }

    #livenessOf(s, id) {
        const e = s.entities.get(id);
        if (!e) return { alive: false, reason: "EVICTED" };
        if (s.dead.has(id)) return { alive: false, reason: s.dead.get(id) };

        if (e.type === ENTITY_TYPE.CLIPBOARD_ITEM) {
            const w = this.#entryEffective(s, s.globalWinners.get("clipboard"));
            if (!w || w.subjectId !== id) {
                return { alive: false, reason: "SUPERSEDED_CLIPBOARD" };
            }
        }

        if (e.type === ENTITY_TYPE.DOCUMENT || e.type === ENTITY_TYPE.TERMINAL ||
            e.type === ENTITY_TYPE.TEXT_SELECTION) {
            const win = this.#scopeWindowOf(s, [], id);
            const prefix = e.type === ENTITY_TYPE.TEXT_SELECTION ? "sel:" : "doc:";
            if (win) {
                if (s.dead.has(win)) return { alive: false, reason: "WINDOW_CLOSED" };
                const sw = this.#entryEffective(s, s.scopedWinners.get(prefix + win));
                if (!sw || sw.subjectId !== id) {
                    return {
                        alive: false,
                        reason: e.type === ENTITY_TYPE.TEXT_SELECTION
                            ? "SUPERSEDED_SELECTION" : "SUPERSEDED_DOCUMENT"
                    };
                }
            }
        }

        return { alive: true, reason: null };
    }

    // ---- pointer aktif (dihitung dari ledger, konvergen) ------------------

    #computeActive(s) {
        const pick = (kind) => {
            const entry = this.#entryEffective(s, s.globalWinners.get(kind));
            if (!entry) return null;
            const lv = this.#livenessOf(s, entry.subjectId);
            return lv.alive ? entry.subjectId : null;
        };

        const windowId = pick("window");

        let applicationId = pick("application");
        if (!applicationId && windowId) {
            for (const rk of (s.idxFrom.get(windowId) ?? [])) {
                const rel = s.relByKey.get(rk);
                if (rel?.relation === RELATIONSHIP.ACTIVE_IN) {
                    const lv = this.#livenessOf(s, rel.to);
                    if (lv.alive) { applicationId = rel.to; break; }
                }
            }
        }

        let documentId = null;
        let selectionGroupId = null;
        if (windowId) {
            const dw = this.#entryEffective(s, s.scopedWinners.get(`doc:${windowId}`));
            if (dw && this.#livenessOf(s, dw.subjectId).alive) documentId = dw.subjectId;
            const sw = this.#entryEffective(s, s.scopedWinners.get(`sel:${windowId}`));
            if (sw && this.#livenessOf(s, sw.subjectId).alive) selectionGroupId = sw.subjectId;
        }
        if (!documentId) documentId = pick("unscopedDoc");
        if (!selectionGroupId) selectionGroupId = pick("unscopedSel");

        return {
            applicationId,
            windowId,
            documentId,
            selectionGroupId,
            fileSelectionGroupId: pick("fileSelection"),
            visualId: pick("visual"),
            workspaceId: pick("workspace"),
            clipboardItemId: pick("clipboard")
        };
    }

    // ---- akses publik ------------------------------------------------------

    #liveEntity(id) {
        if (!id) return null;
        const lv = this.#livenessOf(this.#state(), id);
        if (!lv.alive) return null;
        return this.#entities.get(id) ?? null;
    }

    #state() {
        return {
            entities: this.#entities,
            meta: this.#meta,
            counts: this.#counts,
            relByKey: this.#relByKey,
            idxFrom: this.#idxFrom,
            idxTo: this.#idxTo,
            globalWinners: this.#globalWinners,
            scopedWinners: this.#scopedWinners,
            dead: this.#dead,
            lastClear: this.#lastClear
        };
    }

    getActiveApplication() { return this.#liveEntity(this.#computeActive(this.#state()).applicationId); }
    getActiveWindow() { return this.#liveEntity(this.#computeActive(this.#state()).windowId); }
    getActiveDocument() { return this.#liveEntity(this.#computeActive(this.#state()).documentId); }
    getCurrentSelection() { return this.#liveEntity(this.#computeActive(this.#state()).selectionGroupId); }
    getFileSelectionGroup() { return this.#liveEntity(this.#computeActive(this.#state()).fileSelectionGroupId); }
    getActiveVisualContext() { return this.#liveEntity(this.#computeActive(this.#state()).visualId); }
    getCurrentWorkspace() { return this.#liveEntity(this.#computeActive(this.#state()).workspaceId); }
    getClipboardItem() { return this.#liveEntity(this.#computeActive(this.#state()).clipboardItemId); }

    getSelectedFiles() {
        const group = this.getFileSelectionGroup();
        if (!group) return [];
        const files = [];
        for (const rk of (this.#idxTo.get(group.id) ?? [])) {
            const rel = this.#relByKey.get(rk);
            if (rel?.relation === RELATIONSHIP.BELONGS_TO) {
                const f = this.#liveEntity(rel.from);
                if (f) files.push(f);
            }
        }
        return files.sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    /** Riwayat transisi terurut kunci waktu (deterministik). */
    getTransitionHistory() {
        return this.#history.map((t) => ({ ...t }));
    }

    getDiagnostics() {
        return this.#diagnosticsList.map((d) => ({ ...d }));
    }

    get version() { return this.#version; }

    getStats() {
        return {
            entities: this.#entities.size,
            relationships: this.#relByKey.size,
            dedupeIds: this.#seen.size,
            history: this.#history.length,
            version: this.#version
        };
    }

    // ---- view & snapshot (terdetach — B7) --------------------------------

    getView() {
        const s = this.#state();
        const entitiesView = new Map();
        for (const [id, e] of s.entities) {
            const lv = this.#livenessOf(s, id);
            entitiesView.set(id, ContextEntity.deepFreeze({
                ...e,
                invalid: !lv.alive,
                staleReason: lv.alive ? null : lv.reason
            }));
        }
        const view = {
            schemaVersion: SCHEMA_VERSION,
            entities: entitiesView,
            relationships: [...s.relByKey.values()]
                .sort((a, b) => (a.from + a.relation + a.to < b.from + b.relation + b.to ? -1 : 1))
                .map((r) => Object.freeze({ ...r })),
            active: { ...this.#computeActive(s) },
            recentTransitions: this.#history.map((t) => Object.freeze({ ...t })),
            historyBound: this.#limits.maxHistory,
            historyTruncated: this.#historyTruncated,
            version: this.#version
        };
        return ContextEntity.deepFreeze(view);
    }

    snapshot() {
        return Snapshot.build({
            view: this.getView(),
            createdAt: this.#clock(),
            maxSnapshotBytes: this.#limits.maxSnapshotBytes
        });
    }

    // ---- diagnostik ---------------------------------------------------------

    #diagnose(reasonCode, detail, observationId) {
        this.#diagnosticsList.push({
            at: this.#clock(),
            observationId: observationId ?? null,
            reasonCode,
            detail
        });
        if (this.#diagnosticsList.length > 100) this.#diagnosticsList.shift();
        return { accepted: false, reasonCode, detail };
    }

    // ---- private state (B7: tidak terekspos lewat accessor mana pun) -------

    #clock;
    #limits;
    #adapters = new Map();          // adapterId → {trusted, events:Set}
    #entities = new Map();          // entityId → entity kanonik (pemenang)
    #meta = new Map();              // entityId → {at,confidence,adapter,observationId}
    #counts = new Map();            // entityId → jumlah observasi diterima (=revision)
    #relByKey = new Map();          // "from|relation|to" → rel
    #idxFrom = new Map();           // entityId → Set<relKey>
    #idxTo = new Map();             // entityId → Set<relKey>
    #globalWinners = new Map();     // kind → {key:{at,id}, subjectId}
    #scopedWinners = new Map();     // "doc:w"/"sel:w" → {key, subjectId}
    #dead = new Map();              // entityId → alasan mati eksplisit
    #lastClear = null;              // {at,id} CONTEXT_INVALIDATED global
    #history = [];                  // terurut (at, observationId)
    #historyTruncated = false;
    #seen = new Map();              // observationId → digest (LRU berbatas)
    #diagnosticsList = [];
    #version = 0;

}

function keepWinner(ledger, kind, key, subjectId) {
    const cur = ledger.get(kind);
    if (!cur || cmpKey(key, cur.key) > 0) {
        ledger.set(kind, { key: { ...key }, subjectId });
    }
}

function addIndex(index, id, key) {
    let set = index.get(id);
    if (!set) { set = new Set(); index.set(id, set); }
    set.add(key);
}

function specOf(s, specs, id) {
    return specs.find((x) => x.id === id) ?? s.entities.get(id) ?? null;
}

function findSortedPos(history, entry) {
    let lo = 0, hi = history.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const m = history[mid];
        const c = m.at !== entry.at
            ? (m.at < entry.at ? -1 : 1)
            : (m.observationId < entry.observationId ? -1 : m.observationId > entry.observationId ? 1 : 0);
        if (c < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
}

module.exports = { DesktopContextCore };
