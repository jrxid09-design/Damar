/**
 * CONTEXT ENTITY — simpul semantik immutable dalam graf desktop.
 *
 * Entitas dibekukan (Object.freeze): perubahan observasi menghasilkan
 * revisi baru, bukan mutasi. Provenance dan confidence wajib ada agar
 * setiap penafsiran bisa ditelusuri kembali ke adapter sumbernya.
 */

const { ENTITY_TYPE } = require("./types");

function create({
    id,
    type,
    label = "",
    attributes = {},
    confidence = 1,
    provenance,
    observedAt = null,
    revision = 1
}) {

    if (typeof id !== "string" || !id) {
        throw new Error("ContextEntity butuh id string.");
    }

    if (!Object.values(ENTITY_TYPE).includes(type)) {
        throw new Error(`ContextEntity type tidak dikenal: ${type}`);
    }

    const conf = Number(confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
        throw new Error(`ContextEntity confidence harus angka 0..1: ${confidence}`);
    }

    return Object.freeze({
        id,
        type,
        label: String(label ?? ""),
        attributes: deepFreeze({ ...(attributes ?? {}) }),
        confidence: conf,
        provenance: String(provenance ?? "unknown"),
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
        revision: Math.max(1, Math.floor(revision)),
        invalid: false,
        staleReason: null
    });

}

/** Versi baru entitas (revisi naik); entitas lama tidak diubah. */
function withRevision(entity, patch, { observedAt } = {}) {
    return create({
        id: entity.id,
        type: entity.type,
        label: patch.label ?? entity.label,
        attributes: patch.attributes ?? entity.attributes,
        confidence: patch.confidence ?? entity.confidence,
        provenance: entity.provenance,
        observedAt: observedAt ?? entity.observedAt,
        revision: entity.revision + 1
    });
}

function markInvalid(entity, staleReason) {
    return Object.freeze({
        ...entity,
        invalid: true,
        staleReason: String(staleReason ?? "invalidated")
    });
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
        }
    }
    return value;
}

module.exports = { create, withRevision, markInvalid, deepFreeze };
