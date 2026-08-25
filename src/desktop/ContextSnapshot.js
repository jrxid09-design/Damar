/**
 * CONTEXT SNAPSHOT — proyeksi immutable dari keadaan desktop.
 *
 * Snapshot dibekukan dalam: perubahan observasi berikutnya menghasilkan
 * snapshot baru, bukan mengubah yang lama. Ini memisahkan "keadaan
 * hidup" (core) dari "keadaan yang dilihat kognisi" (snapshot) dan
 * membuat keputusan model bisa diaudit terhadap potret yang persis.
 *
 * Persistence V0 sengaja in-memory bounded; serialize/deserialize
 * disediakan untuk paritas rebuild tanpa membuat arsitektur database
 * kedua.
 */

const { deepFreeze } = require("./ContextEntity");
const { createDesktopContextId } = require("./ids");

/**
 * Bangun snapshot frozen dari view core.
 * View minimal: { entities(Map), relationships(Array), active(Object id),
 * history(Array), selectionByWindow(Map), version }
 */
function build({ view, sequencer, now }) {

    const entityById = new Map();
    for (const [id, entity] of view.entities) {
        if (!entity.invalid) {
            entityById.set(id, entity);
        }
    }

    const active = {};
    for (const key of [
        "applicationId", "windowId", "documentId", "selectionGroupId",
        "fileSelectionGroupId", "visualId", "workspaceId", "clipboardItemId"
    ]) {
        const id = view.active[key] ?? null;
        active[key] = (id && entityById.get(id)) ? entityById.get(id) : null;
    }

    // Berkas pada grup seleksi aktif: FILE yang BELONGS_TO grup.
    const selectedFiles = [];
    const groupId = view.active.fileSelectionGroupId;
    if (groupId && entityById.has(groupId)) {
        for (const rel of view.relationships) {
            if (rel.relation === "belongs_to" && rel.to === groupId && entityById.has(rel.from)) {
                selectedFiles.push(entityById.get(rel.from));
            }
        }
    }

    const snapshot = deepFreeze({
        isContextSnapshot: true,
        desktopContextId: createDesktopContextId(sequencer),
        createdAt: now(),
        sourceVersion: view.version,
        entities: [...entityById.values()],
        relationships: view.relationships.map((r) => ({ ...r })),
        active,
        selectedFiles: Object.freeze([...selectedFiles]),
        recentTransitions: view.history.map((t) => deepFreeze({ ...t })),
        historyBound: view.historyBound,
        historyTruncated: view.historyTruncated
    });

    return snapshot;

}

/** JSON aman (plain object) untuk audit/rebuild. */
function serialize(snapshot) {
    return JSON.stringify(snapshot);
}

/** Bangun ulang snapshot dari JSON; hasil tetap immutable. */
function deserialize(json) {
    const plain = typeof json === "string" ? JSON.parse(json) : json;
    if (!plain || plain.isContextSnapshot !== true) {
        throw new Error("deserialize butuh JSON snapshot yang sah.");
    }
    return deepFreeze(plain);
}

module.exports = { build, serialize, deserialize };
