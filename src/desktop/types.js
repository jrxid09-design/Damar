/**
 * SEMANTIC DESKTOP — tipe kanonik.
 *
 * Prinsip inti: RAW OS STATE != SEMANTIC CONTEXT. Proses dan judul
 * jendela adalah observasi mentah; entitas semantik (dokumen yang
 * sedang diedit, teks terpilih, halaman browser) adalah hasil
 * penafsiran deterministik oleh adapter tepercaya — dengan provenance
 * dan confidence yang selalu terbawa.
 *
 * Substrate ini TIDAK memberi otoritas aktuation apa pun. Observasi
 * bukan izin bertindak (lihat docs/SEMANTIC-DESKTOP.md).
 */

const ENTITY_TYPE = {
    APPLICATION: "application",
    WINDOW: "window",
    DOCUMENT: "document",
    TEXT_SELECTION: "text_selection",
    FILE: "file",
    FILE_SELECTION: "file_selection",
    IMAGE: "image",
    VISUAL_REGION: "visual_region",
    BROWSER_PAGE: "browser_page",
    TERMINAL: "terminal",
    WORKSPACE: "workspace",
    CLIPBOARD_ITEM: "clipboard_item",
    UNKNOWN: "unknown"
};

const RELATIONSHIP = {
    OPENED_BY: "opened_by",
    DISPLAYED_IN: "displayed_in",
    SELECTED_IN: "selected_in",
    BELONGS_TO: "belongs_to",
    ACTIVE_IN: "active_in",
    DERIVED_FROM: "derived_from",
    REFERENCES: "references",
    PARENT_OF: "parent_of",
    WORKSPACE_OF: "workspace_of",
    VISUAL_OF: "visual_of"
};

/** Peristiwa observasi yang dikirim adapter (event model). */
const DESKTOP_EVENT = {
    APPLICATION_ACTIVATED: "application_activated",
    WINDOW_ACTIVATED: "window_activated",
    WINDOW_CLOSED: "window_closed",
    DOCUMENT_CONTEXT_CHANGED: "document_context_changed",
    SELECTION_CHANGED: "selection_changed",
    FILE_SELECTION_CHANGED: "file_selection_changed",
    VISUAL_CONTEXT_CHANGED: "visual_context_changed",
    WORKSPACE_CHANGED: "workspace_changed",
    CLIPBOARD_CHANGED: "clipboard_changed",
    CONTEXT_INVALIDATED: "context_invalidated"
};

/** Transisi temporal (riwayat berbatas untuk frasa seperti "yang tadi"). */
const TRANSITION = {
    WINDOW_ACTIVATED: "window_activated",
    DOCUMENT_OPENED: "document_opened",
    SELECTION_CHANGED: "selection_changed",
    FILES_SELECTED: "files_selected",
    VISUAL_CONTEXT_CHANGED: "visual_context_changed",
    WORKSPACE_CHANGED: "workspace_changed",
    CONTEXT_INVALIDATED: "context_invalidated",
    CONTEXT_CLEARED: "context_cleared"
};

const EVENT_TO_TRANSITION = {
    [DESKTOP_EVENT.APPLICATION_ACTIVATED]: null,
    [DESKTOP_EVENT.WINDOW_ACTIVATED]: TRANSITION.WINDOW_ACTIVATED,
    [DESKTOP_EVENT.WINDOW_CLOSED]: TRANSITION.CONTEXT_INVALIDATED,
    [DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED]: TRANSITION.DOCUMENT_OPENED,
    [DESKTOP_EVENT.SELECTION_CHANGED]: TRANSITION.SELECTION_CHANGED,
    [DESKTOP_EVENT.FILE_SELECTION_CHANGED]: TRANSITION.FILES_SELECTED,
    [DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED]: TRANSITION.VISUAL_CONTEXT_CHANGED,
    [DESKTOP_EVENT.WORKSPACE_CHANGED]: TRANSITION.WORKSPACE_CHANGED,
    [DESKTOP_EVENT.CLIPBOARD_CHANGED]: null,
    [DESKTOP_EVENT.CONTEXT_INVALIDATED]: TRANSITION.CONTEXT_CLEARED
};

/**
 * Kapabilitas adapter — kontrak terdaftar yang membatasi kelas event
 * yang boleh dikirim. Adapter hanya boleh mengamati apa yang ia
 * deklarasikan; sisanya ditolak (B5).
 */
const CAPABILITY_EVENTS = {
    active_window_metadata: [
        DESKTOP_EVENT.APPLICATION_ACTIVATED,
        DESKTOP_EVENT.WINDOW_ACTIVATED,
        DESKTOP_EVENT.WINDOW_CLOSED
    ],
    document_context: [DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED],
    text_selection_metadata: [DESKTOP_EVENT.SELECTION_CHANGED],
    file_selection: [DESKTOP_EVENT.FILE_SELECTION_CHANGED],
    visual_reference_only: [DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED],
    workspace_context: [DESKTOP_EVENT.WORKSPACE_CHANGED],
    clipboard_metadata: [DESKTOP_EVENT.CLIPBOARD_CHANGED],
    context_invalidation: [DESKTOP_EVENT.CONTEXT_INVALIDATED]
};

/** Tipe entitas yang sah menjadi subject per jenis event (B9). */
const SUBJECT_ALLOWED_TYPES = {
    [DESKTOP_EVENT.APPLICATION_ACTIVATED]: [ENTITY_TYPE.APPLICATION],
    [DESKTOP_EVENT.WINDOW_ACTIVATED]: [ENTITY_TYPE.WINDOW],
    [DESKTOP_EVENT.WINDOW_CLOSED]: [ENTITY_TYPE.WINDOW],
    [DESKTOP_EVENT.DOCUMENT_CONTEXT_CHANGED]: [ENTITY_TYPE.DOCUMENT, ENTITY_TYPE.TERMINAL],
    [DESKTOP_EVENT.SELECTION_CHANGED]: [ENTITY_TYPE.TEXT_SELECTION],
    [DESKTOP_EVENT.FILE_SELECTION_CHANGED]: [ENTITY_TYPE.FILE_SELECTION],
    [DESKTOP_EVENT.VISUAL_CONTEXT_CHANGED]: [ENTITY_TYPE.IMAGE, ENTITY_TYPE.VISUAL_REGION],
    [DESKTOP_EVENT.WORKSPACE_CHANGED]: [ENTITY_TYPE.WORKSPACE],
    [DESKTOP_EVENT.CLIPBOARD_CHANGED]: [ENTITY_TYPE.CLIPBOARD_ITEM]
};

/** Tipe entitas yang sah untuk tiap pointer aktif snapshot (B1/B9). */
const POINTER_ENTITY_TYPES = {
    applicationId: [ENTITY_TYPE.APPLICATION],
    windowId: [ENTITY_TYPE.WINDOW],
    documentId: [ENTITY_TYPE.DOCUMENT, ENTITY_TYPE.TERMINAL],
    selectionGroupId: [ENTITY_TYPE.TEXT_SELECTION],
    fileSelectionGroupId: [ENTITY_TYPE.FILE_SELECTION],
    visualId: [ENTITY_TYPE.IMAGE, ENTITY_TYPE.VISUAL_REGION],
    workspaceId: [ENTITY_TYPE.WORKSPACE],
    clipboardItemId: [ENTITY_TYPE.CLIPBOARD_ITEM]
};

/** Kode alasan deterministik untuk resolusi & ingest. */
const REASON_CODE = {
    RESOLVED: "RESOLVED",
    AMBIGUOUS_TARGETS: "AMBIGUOUS_TARGETS",
    STALE_CONTEXT: "STALE_CONTEXT",
    NO_ACTIVE_APPLICATION: "NO_ACTIVE_APPLICATION",
    NO_ACTIVE_WINDOW: "NO_ACTIVE_WINDOW",
    NO_ACTIVE_DOCUMENT: "NO_ACTIVE_DOCUMENT",
    NO_SELECTION: "NO_SELECTION",
    NO_SELECTED_FILES: "NO_SELECTED_FILES",
    NO_VISUAL_CONTEXT: "NO_VISUAL_CONTEXT",
    NO_WORKSPACE: "NO_WORKSPACE",
    HISTORY_EMPTY: "HISTORY_EMPTY",
    CONSTRAINT_UNMATCHED: "CONSTRAINT_UNMATCHED",
    UNKNOWN_RESOLUTION_KIND: "UNKNOWN_RESOLUTION_KIND",
    // ingest
    ACCEPTED: "ACCEPTED",
    DUPLICATE_OBSERVATION: "DUPLICATE_OBSERVATION",
    CONFLICTING_OBSERVATION: "CONFLICTING_OBSERVATION",
    REJECTED_UNTRUSTED_SOURCE: "REJECTED_UNTRUSTED_SOURCE",
    REJECTED_CAPABILITY: "REJECTED_CAPABILITY",
    UNRESOLVED_SUBJECT: "UNRESOLVED_SUBJECT",
    DANGLING_RELATIONSHIP: "DANGLING_RELATIONSHIP",
    INVALID_ACTIVE_TARGET: "INVALID_ACTIVE_TARGET",
    ATTRIBUTES_NOT_SERIALIZABLE: "ATTRIBUTES_NOT_SERIALIZABLE",
    ATTRIBUTES_TOO_LARGE: "ATTRIBUTES_TOO_LARGE",
    INGEST_COMPUTE_FAILED: "INGEST_COMPUTE_FAILED"
};

const SCHEMA_VERSION = 1;

module.exports = {
    ENTITY_TYPE,
    RELATIONSHIP,
    DESKTOP_EVENT,
    TRANSITION,
    EVENT_TO_TRANSITION,
    CAPABILITY_EVENTS,
    SUBJECT_ALLOWED_TYPES,
    POINTER_ENTITY_TYPES,
    REASON_CODE,
    SCHEMA_VERSION
};
