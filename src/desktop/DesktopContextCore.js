/**
 * DESKTOP CONTEXT CORE — keadaan semantik desktop yang kanonik.
 *
 * Aturan main:
 * 1. Satu-satunya jalan masuk perubahan adalah `ingest()` dari adapter
 *    TERDAFTAR + tepercaya. Tidak ada API mutasi lain — output model
 *    tidak bisa memproduksi observasi (model boundary).
 * 2. Observasi dedupe by observationId (idempoten); event cacat ditolak
 *    diagnostik; sumber tak dikenal ditolak.
 * 3. Menutup jendela menginvalidasi konteks anaknya (dokumen, seleksi,
 *   visual). Entitas basi tetap disimpan dengan staleReason — tidak
 *    dihapus diam-diam.
 * 4. Riwayat transisi berbatas (ring buffer) untuk resolusi "yang
 *    tadi" tanpa surveillance sejarah desktop tanpa batas.
 * 5. Snapshot immutable dibangun lewat ContextSnapshot.build.
 *
 * Substrate ini memberi NOL otoritas actuation: tidak ada metode
 * eksekusi/kontrol apa pun di sini.
 */

const ContextEntity = require("./ContextEntity");
const Observation = require("./ContextObservation");
const Snapshot = require("./ContextSnapshot");
const {
    DESKTOP_EVENT,
    EVENT_TO_TRANSITION,
    RELATIONSHIP
} = require("./types");
const { createIdSequencer } = require("./ids");

const CHILD_RELATIONS = new Set([
    RELATIONSHIP.DISPLAYED_IN,
    RELATIONSHIP.SELECTED_IN,
    RELATIONSHIP.VISUAL_OF,
    RELATIONSHIP.BELONGS_TO
]);

class DesktopContextCore {

    constructor(options = {}) {
        this._clock = typeof options.clock === "function" ? options.clock : (() => Date.now());
        this._maxHistory = clampInt(options.maxHistory, 1, 500, 50);
        this._sequencer = createIdSequencer({
            prefix: options.idPrefix ?? "aether-desktop"
        });

        this._entities = new Map();          // id → entity (termasuk invalid)
        this._relationships = [];            // {from, relation, to}
        this._relationshipKeys = new Set();
        this._active = {
            applicationId: null,
            windowId: null,
            documentId: null,
            selectionGroupId: null,
            fileSelectionGroupId: null,
            visualId: null,
            workspaceId: null,
            clipboardItemId: null
        };
        this._selectionByWindow = new Map(); // windowId → selection entity id
        this._documentByWindow = new Map();  // windowId → document entity id
        this._history = [];
        this._historyTruncated = false;
        this._diagnostics = [];
        this._seenObservations = new Set();
        this._adapters = new Map();          // adapterId → {trusted, capabilities}
        this._version = 0;
    }

    // ---- adapter ------------------------------------------------------

    /** Hanya adapter terdaftar yang boleh mengubah keadaan kanonik. */
    registerAdapter({ adapterId, trusted = true, capabilities = [] }) {
        if (typeof adapterId !== "string" || !adapterId) {
            throw new Error("registerAdapter butuh adapterId string.");
        }
        this._adapters.set(adapterId, { trusted: trusted !== false, capabilities: [...capabilities] });
        return this;
    }

    isAdapterRegistered(adapterId) {
        return this._adapters.has(adapterId);
    }

    // ---- ingest (satu-satunya jalur mutasi) ---------------------------

    ingest(raw) {

        const check = Observation.validate(raw);
        if (!check.ok) {
            return this._diagnose(check.reasonCode, check.detail, raw?.observationId);
        }

        const obs = check.value;

        if (!this._adapters.has(obs.source.adapterId)) {
            return this._diagnose("REJECTED_UNTRUSTED_SOURCE",
                `adapter '${obs.source.adapterId}' tidak terdaftar`, obs.observationId);
        }
        if (!obs.source.trusted || this._adapters.get(obs.source.adapterId).trusted !== true) {
            return this._diagnose("REJECTED_UNTRUSTED_SOURCE",
                `adapter '${obs.source.adapterId}' tidak tepercaya`, obs.observationId);
        }
        if (this._seenObservations.has(obs.observationId)) {
            return this._diagnose("DUPLICATE_OBSERVATION",
                "observasi identik sudah diproses (idempoten)", obs.observationId);
        }

        this._upsertEntities(obs);
        this._mergeRelationships(obs);

        switch (obs.type) {

            case DESKTOP_EVENT.APPLICATION_ACTIVATED:
                this._setActive("applicationId", obs.subject, obs);
                break;

            case DESKTOP_EVENT.WINDOW_ACTIVATED: {
                this._setActive("windowId", obs.subject, obs);
                // Jendela yang membawa dokumen langsung menjadikannya
                // dokumen aktif (contoh: "catatan.txt - Notepad").
                const doc = obs.entities.find((e) => e.type === "document");
                if (doc) {
                    this._setActive("documentId", doc.id, obs);
                    this._documentByWindow.set(obs.subject, doc.id);
                }
                // Aplikasi induk jendela (relasi active_in) ikut aktif.
                const appRel = obs.relationships.find((r) =>
                    r.from === obs.subject && r.relation === "active_in");
                if (appRel) {
                    this._setActive("applicationId", appRel.to, obs);
                }
                break;
            }

            case DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED: {
                this._supersedeForWindow(this._documentByWindow, obs, "SUPERSEDED_DOCUMENT");
                this._setActive("documentId", obs.subject, obs);
                break;
            }

            case DESKTOP_EVENT.SELECTION_CHANGED: {
                this._supersedeForWindow(this._selectionByWindow, obs, "SUPERSEDED_SELECTION");
                this._setActive("selectionGroupId", obs.subject, obs);
                break;
            }

            case DESKTOP_EVENT.FILE_SELECTION_CHANGED:
                this._setActive("fileSelectionGroupId", obs.subject, obs);
                break;

            case DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED:
                this._setActive("visualId", obs.subject, obs);
                break;

            case DESKTOP_EVENT.WORKSPACE_CHANGED:
                this._setActive("workspaceId", obs.subject, obs);
                break;

            case DESKTOP_EVENT.CLIPBOARD_CHANGED: {
                // Clipboard tanpa history: item baru membuat item lama basi.
                const prevClip = this._active.clipboardItemId;
                if (prevClip && prevClip !== obs.subject) {
                    const prev = this._entities.get(prevClip);
                    if (prev && !prev.invalid) {
                        this._entities.set(prevClip,
                            ContextEntity.markInvalid(prev, "SUPERSEDED_CLIPBOARD"));
                    }
                }
                this._setActive("clipboardItemId", obs.subject, obs);
                break;
            }

            case DESKTOP_EVENT.WINDOW_CLOSED:
                this._invalidateWindowSubtree(obs.subject);
                break;

            case DESKTOP_EVENT.CONTEXT_INVALIDATED:
                this._clearPointers(obs.subject, obs.payload?.reason ?? "invalidated");
                break;

            default:
                break;
        }

        this._seenObservations.add(obs.observationId);
        this._pushTransition(obs);
        this._version += 1;

        return { accepted: true, reasonCode: "ACCEPTED", observationId: obs.observationId };
    }

    // ---- akses keadaan aktif ------------------------------------------

    getActiveApplication() { return this._live(this._active.applicationId); }
    getActiveWindow() { return this._live(this._active.windowId); }
    getActiveDocument() { return this._live(this._active.documentId); }
    getCurrentSelection() { return this._live(this._active.selectionGroupId); }
    getFileSelectionGroup() { return this._live(this._active.fileSelectionGroupId); }
    getSelectedFiles() {
        const group = this.getFileSelectionGroup();
        if (!group) return [];
        return this._relationships
            .filter((r) => r.relation === RELATIONSHIP.BELONGS_TO && r.to === group.id)
            .map((r) => this._live(r.from))
            .filter(Boolean);
    }
    getActiveVisualContext() { return this._live(this._active.visualId); }
    getCurrentWorkspace() { return this._live(this._active.workspaceId); }
    getClipboardItem() { return this._live(this._active.clipboardItemId); }

    getTransitionHistory() {
        return this._history.map((t) => ({ ...t }));
    }

    getDiagnostics() {
        return this._diagnostics.map((d) => ({ ...d }));
    }

    get version() { return this._version; }

    // ---- view & snapshot ----------------------------------------------

    /** View polos untuk ContextSnapshot / resolver. */
    getView() {
        return {
            entities: this._entities,
            relationships: [...this._relationships],
            active: { ...this._active },
            history: this.getTransitionHistory(),
            historyBound: this._maxHistory,
            historyTruncated: this._historyTruncated,
            version: this._version
        };
    }

    snapshot() {
        return Snapshot.build({
            view: this.getView(),
            sequencer: this._sequencer,
            now: this._clock
        });
    }

    // ---- internal -------------------------------------------------------

    _live(entityId) {
        if (!entityId) return null;
        const e = this._entities.get(entityId);
        return e && !e.invalid ? e : null;
    }

    _setActive(pointerKey, entityId, obs) {
        if (entityId && this._live(entityId)) {
            this._active[pointerKey] = entityId;
            if (pointerKey === "selectionGroupId") {
                const winId = this._windowOf(obs.subject) ?? this._active.windowId;
                if (winId) this._selectionByWindow.set(winId, entityId);
            }
            if (pointerKey === "documentId") {
                const winId = this._windowOf(obs.subject) ?? this._active.windowId;
                if (winId) this._documentByWindow.set(winId, entityId);
            }
        } else if (entityId === null) {
            this._active[pointerKey] = null;
        }
    }

    _windowOf(entityId) {
        for (const rel of this._relationships) {
            if (rel.from === entityId &&
                (rel.relation === RELATIONSHIP.DISPLAYED_IN ||
                 rel.relation === RELATIONSHIP.SELECTED_IN ||
                 rel.relation === RELATIONSHIP.ACTIVE_IN)) {
                const target = this._entities.get(rel.to);
                if (target?.type === "window") return rel.to;
            }
        }
        return null;
    }

    _upsertEntities(obs) {
        for (const spec of obs.entities) {
            const existing = this._entities.get(spec.id);
            if (!existing) {
                this._entities.set(spec.id, ContextEntity.create({
                    id: spec.id,
                    type: spec.type,
                    label: spec.label,
                    attributes: spec.attributes,
                    confidence: spec.confidence,
                    provenance: `${spec.provenance} @ ${obs.source.provenance}`,
                    observedAt: obs.timestamp
                }));
                continue;
            }
            const signature = JSON.stringify([spec.label, spec.attributes]);
            const prevSignature = JSON.stringify([existing.label, existing.attributes]);
            if (signature !== prevSignature && !existing.invalid) {
                this._entities.set(spec.id, ContextEntity.withRevision(existing, {
                    label: spec.label,
                    attributes: spec.attributes,
                    confidence: spec.confidence
                }, { observedAt: obs.timestamp }));
            }
        }
    }

    _mergeRelationships(obs) {
        for (const rel of obs.relationships) {
            const key = `${rel.from}|${rel.relation}|${rel.to}`;
            if (!this._relationshipKeys.has(key)) {
                this._relationshipKeys.add(key);
                this._relationships.push(rel);
            }
        }
    }

    _supersedeForWindow(byWindow, obs, staleReason) {
        const winId = this._windowOf(obs.subject) ?? this._active.windowId;
        const prevId = winId ? byWindow.get(winId) : null;
        if (prevId && prevId !== obs.subject) {
            const prev = this._entities.get(prevId);
            if (prev && !prev.invalid) {
                this._entities.set(prevId, ContextEntity.markInvalid(prev, staleReason));
            }
        }
    }

    _invalidateWindowSubtree(windowId) {
        if (!windowId || !this._entities.has(windowId)) return;

        const doomed = new Set();
        for (const rel of this._relationships) {
            if (rel.to === windowId && CHILD_RELATIONS.has(rel.relation)) {
                doomed.add(rel.from);
            }
        }
        doomed.add(windowId);

        for (const id of doomed) {
            const e = this._entities.get(id);
            if (e && !e.invalid) {
                this._entities.set(id, ContextEntity.markInvalid(e, "WINDOW_CLOSED"));
            }
        }

        for (const key of Object.keys(this._active)) {
            if (this._active[key] && doomed.has(this._active[key])) {
                this._active[key] = null;
            }
        }
        for (const [win, selId] of [...this._selectionByWindow]) {
            if (doomed.has(win) || doomed.has(selId)) this._selectionByWindow.delete(win);
        }
        for (const [win, docId] of [...this._documentByWindow]) {
            if (doomed.has(win) || doomed.has(docId)) this._documentByWindow.delete(win);
        }
    }

    _clearPointers(subjectId, reason) {
        for (const key of Object.keys(this._active)) {
            if (subjectId ? this._active[key] === subjectId : Boolean(this._active[key])) {
                this._active[key] = null;
            }
        }
        void reason;
    }

    _pushTransition(obs) {
        const transitionType = EVENT_TO_TRANSITION[obs.type];
        if (!transitionType) return;
        const entry = {
            id: this._sequencer.nextId("tr"),
            transitionType,
            at: obs.timestamp,
            observedAtClock: this._clock(),
            observationId: obs.observationId,
            source: obs.source.adapterId,
            subjectIds: obs.subject ? [obs.subject] : []
        };
        this._history.push(entry);
        while (this._history.length > this._maxHistory) {
            this._history.shift();
            this._historyTruncated = true;
        }
    }

    _diagnose(reasonCode, detail, observationId) {
        this._diagnostics.push({
            at: this._clock(),
            observationId: observationId ?? null,
            reasonCode,
            detail
        });
        if (this._diagnostics.length > 100) this._diagnostics.shift();
        return { accepted: false, reasonCode, detail };
    }

}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

module.exports = { DesktopContextCore };
