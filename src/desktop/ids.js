/**
 * ID — penghasil identitas deterministik untuk substrate desktop.
 *
 * DesktopContextId menandai snapshot; ContextEntityId stabil per
 * entitas lintas observasi (adapter yang memakai id sama menghasilkan
 * entitas yang sama, bukan duplikat). Sequencer di-inject supaya tes
 * bisa berjalan deterministik tanpa jam nyata.
 */

function createIdSequencer({ prefix = "aether-desktop", seed = 0 } = {}) {
    let next = Number.isFinite(seed) ? seed : 0;
    return {
        prefix,
        nextId(label = "id") {
            const n = ++next;
            return `${prefix}-${label}-${String(n).padStart(6, "0")}`;
        }
    };
}

function createDesktopContextId(sequencer) {
    return sequencer.nextId("dctx");
}

function createEntityId(sequencer, entityType) {
    return sequencer.nextId(`ent-${entityType}`);
}

function createTransitionId(sequencer) {
    return sequencer.nextId("tr");
}

module.exports = { createIdSequencer, createDesktopContextId, createEntityId, createTransitionId };
