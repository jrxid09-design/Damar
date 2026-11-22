/**
 * CONTEXT ENTITY — simpul semantik immutable dalam graf desktop.
 *
 * Entitas dibekukan (Object.freeze): perubahan observasi menghasilkan
 * versi kanonik baru, bukan mutasi. `provenance` selalu identitas
 * adapter TERDAFTAR (fakta tepercaya yang dicap core — B5); klaim
 * provenance dari payload event disimpan terpisah di
 * `claimedProvenance` sebagai metadata tak tepercaya.
 */

const { ENTITY_TYPE } = require("./types");

function create({
    id,
    type,
    label = "",
    attributes = {},
    confidence = 1,
    provenance,
    claimedProvenance = null,
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
        claimedProvenance: typeof claimedProvenance === "string" ? claimedProvenance : null,
        observedAt: Number.isFinite(observedAt) ? observedAt : null,
        revision: Math.max(1, Math.floor(revision)),
        invalid: false,
        staleReason: null
    });

}

/** Salinan ber-revisi (payload sama, nomor revisi naik). */
function withRevision(entity, revision) {
    return Object.freeze({ ...entity, revision: Math.max(1, Math.floor(revision)) });
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

module.exports = { create, withRevision, deepFreeze };
