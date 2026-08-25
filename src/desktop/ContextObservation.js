/**
 * CONTEXT OBSERVATION — validasi event observasi desktop.
 *
 * Setiap event dari adapter harus punya: observationId stabil,
 * timestamp, sumber (adapterId terdaftar + trusted), subject
 * ternormalisasi (boleh null), dan payload. Event cacat DITOLAK
 * secara diagnostik — tidak pernah diam-diam diperbaiki, karena
 * observasi yang "ditebak" akan mengotori realitas yang justru
 * ingin dijaga substrate ini.
 */

const { DESKTOP_EVENT, ENTITY_TYPE, RELATIONSHIP } = require("./types");

const MALFORMED_CODES = {
    NOT_OBJECT: "MALFORMED_EVENT_NOT_OBJECT",
    UNKNOWN_EVENT: "MALFORMED_EVENT_UNKNOWN_TYPE",
    MISSING_OBSERVATION_ID: "MALFORMED_EVENT_NO_OBSERVATION_ID",
    BAD_TIMESTAMP: "MALFORMED_EVENT_BAD_TIMESTAMP",
    MISSING_SOURCE: "MALFORMED_EVENT_NO_SOURCE",
    BAD_ENTITIES: "MALFORMED_EVENT_BAD_ENTITIES",
    BAD_RELATIONSHIPS: "MALFORMED_EVENT_BAD_RELATIONSHIPS",
    BAD_SUBJECT: "MALFORMED_EVENT_BAD_SUBJECT",
    BAD_PAYLOAD: "MALFORMED_EVENT_BAD_PAYLOAD"
};

/**
 * Validasi bentuk. Mengembalikan { ok, reasonCode?, detail?, value? }
 * — `value` adalah observasi ternormalisasi (tanpa perubahan makna).
 */
function validate(raw) {

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return reject(MALFORMED_CODES.NOT_OBJECT, "observasi harus objek");
    }

    if (!Object.values(DESKTOP_EVENT).includes(raw.type)) {
        return reject(MALFORMED_CODES.UNKNOWN_EVENT, `type tidak dikenal: ${raw.type}`);
    }

    if (typeof raw.observationId !== "string" || !raw.observationId) {
        return reject(MALFORMED_CODES.MISSING_OBSERVATION_ID, "observationId wajib string non-kosong");
    }

    const timestamp = raw.timestamp;
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return reject(MALFORMED_CODES.BAD_TIMESTAMP, "timestamp harus epoch ms positif");
    }

    if (!raw.source || typeof raw.source.adapterId !== "string" || !raw.source.adapterId) {
        return reject(MALFORMED_CODES.MISSING_SOURCE, "source.adapterId wajib");
    }

    const entities = [];
    for (const e of Array.isArray(raw.entities) ? raw.entities : []) {
        if (!e || typeof e.id !== "string" || !e.id) {
            return reject(MALFORMED_CODES.BAD_ENTITIES, "entity butuh id string");
        }
        if (!Object.values(ENTITY_TYPE).includes(e.type)) {
            return reject(MALFORMED_CODES.BAD_ENTITIES, `entity type tidak dikenal: ${e.type}`);
        }
        entities.push({
            id: e.id,
            type: e.type,
            label: String(e.label ?? ""),
            attributes: isPlainObject(e.attributes) ? e.attributes : {},
            confidence: normalizeConfidence(e.confidence),
            provenance: String(e.provenance ?? `adapter:${raw.source.adapterId}`)
        });
    }

    const relationships = [];
    for (const r of Array.isArray(raw.relationships) ? raw.relationships : []) {
        if (!r || typeof r.from !== "string" || typeof r.to !== "string") {
            return reject(MALFORMED_CODES.BAD_RELATIONSHIPS, "relationship butuh from/to entity id");
        }
        if (!Object.values(RELATIONSHIP).includes(r.relation)) {
            return reject(MALFORMED_CODES.BAD_RELATIONSHIPS, `relation tidak dikenal: ${r.relation}`);
        }
        relationships.push({ from: r.from, relation: r.relation, to: r.to });
    }

    if (raw.subject !== undefined && raw.subject !== null && typeof raw.subject !== "string") {
        return reject(MALFORMED_CODES.BAD_SUBJECT, "subject harus entity id string atau null");
    }

    if (raw.payload !== undefined && !isPlainObject(raw.payload)) {
        return reject(MALFORMED_CODES.BAD_PAYLOAD, "payload harus objek polos");
    }

    return {
        ok: true,
        value: Object.freeze({
            type: raw.type,
            observationId: raw.observationId,
            timestamp,
            source: Object.freeze({
                adapterId: raw.source.adapterId,
                trusted: raw.source.trusted !== false,
                provenance: String(raw.source.provenance ?? `adapter:${raw.source.adapterId}`)
            }),
            subject: raw.subject ?? null,
            entities,
            relationships,
            payload: Object.freeze({ ...(raw.payload ?? {}) })
        })
    };

}

function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0, n));
}

function isPlainObject(v) {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function reject(reasonCode, detail) {
    return { ok: false, reasonCode, detail };
}

module.exports = { validate, MALFORMED_CODES };
