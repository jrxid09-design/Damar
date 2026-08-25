/**
 * FAKE DESKTOP ADAPTER — adapter observasi deterministik untuk V0.
 *
 * Membuktikan kontrak lifecycle adapter tanpa OS nyata: start/stop
 * eksplisit, emit hanya saat berjalan, id stabil lintas observasi,
 * metadata-first (tanpa byte gambar, tanpa clipboard history), dan
 * TANPA loop tangkapan-layar kontinu (tidak ada timer/polling di sini).
 *
 * Identitas observasi menyertakan nonce instance (B4):
 *   fake-desktop:<instanceNonce>:<sequence>
 * sehingga restart adapter tidak menabrak ID instance sebelumnya.
 */

const crypto = require("node:crypto");
const { DESKTOP_EVENT, ENTITY_TYPE, RELATIONSHIP } = require("../types");

const ADAPTER_ID = "fake-desktop";

/** Kapabilitas penuh untuk skenario pengujian. */
const CAPABILITIES = Object.freeze([
    "active_window_metadata",
    "document_context",
    "text_selection_metadata",
    "file_selection",
    "visual_reference_only",
    "workspace_context",
    "clipboard_metadata",
    "context_invalidation"
]);

class FakeDesktopAdapter {

    /**
     * `emit` adalah sink yang diberikan host (biasanya core.ingest).
     * Clock di-inject supaya deterministik penuh.
     */
    constructor({ emit, clock = () => Date.now(), instanceNonce = null } = {}) {
        if (typeof emit !== "function") {
            throw new Error("FakeDesktopAdapter butuh sink emit.");
        }
        this._emit = emit;
        this._clock = clock;
        this._nonce = instanceNonce ??
            crypto.randomBytes(6).toString("hex");
        this._seq = 0;
        this._running = false;
        this.capabilities = CAPABILITIES;
    }

    get adapterId() { return ADAPTER_ID; }
    get instanceNonce() { return this._nonce; }
    get isRunning() { return this._running; }

    start() {
        if (this._running) {
            throw new Error(`[${ADAPTER_ID}] start ganda ditolak.`);
        }
        this._running = true;
    }

    stop() {
        if (!this._running) return;
        this._running = false;
    }

    // ---- skenario deterministik ---------------------------------------

    activateApplication({ id = "app-notepad", label = "Notepad" } = {}) {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.APPLICATION_ACTIVATED,
            subject: id,
            entities: [this._entity(id, ENTITY_TYPE.APPLICATION, label)]
        });
    }

    activateWindow({
        windowId = "win-notepad-main",
        label = "catatan.txt - Notepad",
        appId = "app-notepad",
        documentId = null,
        documentPath = null
    } = {}) {
        this._guard();
        const entities = [
            this._entity(windowId, ENTITY_TYPE.WINDOW, label),
            this._entity(appId, ENTITY_TYPE.APPLICATION, "Notepad")
        ];
        const relationships = [
            { from: windowId, relation: RELATIONSHIP.ACTIVE_IN, to: appId }
        ];
        if (documentId) {
            entities.push(this._entity(documentId, ENTITY_TYPE.DOCUMENT,
                documentPath ?? "catatan.txt", { path: documentPath }));
            relationships.push(
                { from: documentId, relation: RELATIONSHIP.DISPLAYED_IN, to: windowId },
                { from: documentId, relation: RELATIONSHIP.OPENED_BY, to: appId }
            );
        }
        return this._send({
            type: DESKTOP_EVENT.WINDOW_ACTIVATED,
            subject: windowId,
            entities,
            relationships
        });
    }

    openDocument({ documentId, path, windowId }) {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED,
            subject: documentId,
            entities: [this._entity(documentId, ENTITY_TYPE.DOCUMENT, path, { path })],
            relationships: [
                { from: documentId, relation: RELATIONSHIP.DISPLAYED_IN, to: windowId }
            ]
        });
    }

    selectText({ selectionId, text, length, windowId }) {
        this._guard();
        // Minimisasi konten: metadata + cuplikan pendek eksplisit dari
        // adapter, BUKAN dump isi dokumen. Panjang selalu dicatat.
        const excerpt = typeof text === "string" ? text.slice(0, 120) : "";
        return this._send({
            type: DESKTOP_EVENT.SELECTION_CHANGED,
            subject: selectionId,
            entities: [this._entity(selectionId, ENTITY_TYPE.TEXT_SELECTION,
                `selection:${length}ch`, { length, excerpt })],
            relationships: [
                { from: selectionId, relation: RELATIONSHIP.SELECTED_IN, to: windowId }
            ]
        });
    }

    selectFiles({ groupId, files, windowId }) {
        this._guard();
        const entities = [this._entity(groupId, ENTITY_TYPE.FILE_SELECTION,
            `${files.length} file terpilih`)];
        const relationships = [];
        for (const f of files) {
            entities.push(this._entity(f.id, ENTITY_TYPE.FILE, f.label, { path: f.path }));
            relationships.push({ from: f.id, relation: RELATIONSHIP.BELONGS_TO, to: groupId });
        }
        if (windowId) {
            relationships.push({ from: groupId, relation: RELATIONSHIP.SELECTED_IN, to: windowId });
        }
        return this._send({
            type: DESKTOP_EVENT.FILE_SELECTION_CHANGED,
            subject: groupId,
            entities,
            relationships
        });
    }

    showVisualReference({
        imageId,
        source = "active_file",
        mimeType = "image/png",
        width = null,
        height = null,
        sourceRef = null,
        windowId = null
    } = {}) {
        this._guard();
        // Reference-first: TIDAK ADA byte gambar di sini. captureRequired
        // menandai bahwa akuisisi konten butuh langkah eksplisit masa depan.
        const entities = [this._entity(imageId, ENTITY_TYPE.IMAGE, sourceRef ?? source, {
            visualSource: source,
            mimeType,
            width,
            height,
            captureRequired: true
        })];
        const relationships = [];
        if (windowId) {
            relationships.push({ from: imageId, relation: RELATIONSHIP.VISUAL_OF, to: windowId });
        }
        return this._send({
            type: DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED,
            subject: imageId,
            entities,
            relationships
        });
    }

    changeWorkspace({ workspaceId, label, projectRoot }) {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.WORKSPACE_CHANGED,
            subject: workspaceId,
            entities: [this._entity(workspaceId, ENTITY_TYPE.WORKSPACE, label, { projectRoot })]
        });
    }

    addTerminal({ terminalId, cwd, workspaceId }) {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED,
            subject: terminalId,
            entities: [this._entity(terminalId, ENTITY_TYPE.TERMINAL, "terminal", { cwd })],
            relationships: [
                { from: terminalId, relation: RELATIONSHIP.WORKSPACE_OF, to: workspaceId }
            ]
        });
    }

    setClipboardItem({ itemId, contentType = "text/plain", length = 0 }) {
        this._guard();
        // Representasi saja — TIDAK ada clipboard history.
        return this._send({
            type: DESKTOP_EVENT.CLIPBOARD_CHANGED,
            subject: itemId,
            entities: [this._entity(itemId, ENTITY_TYPE.CLIPBOARD_ITEM,
                `clipboard:${contentType}`, { contentType, length })]
        });
    }

    closeWindow({ windowId }) {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.WINDOW_CLOSED,
            subject: windowId
        });
    }

    clearContext() {
        this._guard();
        return this._send({
            type: DESKTOP_EVENT.CONTEXT_INVALIDATED,
            subject: null
        });
    }

    // ---- internal -------------------------------------------------------

    _entity(id, type, label, attributes = {}) {
        return {
            id,
            type,
            label,
            attributes,
            confidence: 1,
            provenance: `adapter:${ADAPTER_ID}`
        };
    }

    _send(spec) {
        this._seq += 1;
        return this._emit({
            type: spec.type,
            observationId: `${ADAPTER_ID}:${this._nonce}:${String(this._seq).padStart(4, "0")}`,
            timestamp: this._clock(),
            source: {
                adapterId: ADAPTER_ID
            },
            subject: spec.subject ?? null,
            entities: spec.entities ?? [],
            relationships: spec.relationships ?? [],
            payload: {}
        });
    }

    _guard() {
        if (!this._running) {
            throw new Error(`[${ADAPTER_ID}] emit sebelum start() / sesudah stop() ditolak.`);
        }
    }

}

module.exports = { FakeDesktopAdapter, ADAPTER_ID, CAPABILITIES };
