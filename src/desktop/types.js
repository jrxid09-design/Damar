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
    [DESKTOP_EVENT.CONTEXT_INVALIDATED]: TRANSITION.CONTEXT_CLEARED
};

/** Kode alasan deterministik untuk resolusi referensi. */
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
    NO_CLIPBOARD_ITEM: "NO_CLIPBOARD_ITEM",
    HISTORY_EMPTY: "HISTORY_EMPTY",
    CONSTRAINT_UNMATCHED: "CONSTRAINT_UNMATCHED",
    UNKNOWN_RESOLUTION_KIND: "UNKNOWN_RESOLUTION_KIND"
};

module.exports = {
    ENTITY_TYPE,
    RELATIONSHIP,
    DESKTOP_EVENT,
    TRANSITION,
    EVENT_TO_TRANSITION,
    REASON_CODE
};
