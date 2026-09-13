"use strict";

/**
 * W7-L2 WORLD MODEL — pembangun record murni (spec §4): WorldEntity,
 * WorldRelation, WorldObservation, WorldHypothesis. Tidak menyentuh state;
 * hanya validasi bentuk + batas, lalu mengembalikan objek beku.
 */

const { clamp01 } = require("../core/envelope");
const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

const ADMISSIBLE_TIERS = new Set(["T1", "T2", "T4"]);

function validateLabels(labels) {
    if (labels == null) return {};
    const keys = Object.keys(labels);
    if (keys.length > BOUNDS.MAX_ENTITY_LABEL_KEYS) {
        fail(REASONS.BOUND_EXCEEDED, "jumlah label melebihi batas");
    }
    const out = {};
    for (const key of keys) {
        const value = String(labels[key] ?? "").slice(0, BOUNDS.MAX_ENTITY_LABEL_CHARS);
        out[key.slice(0, 128)] = value;
    }
    return Object.freeze(out);
}

function makeEntity({ entityId, entityKind, labels, externalRefs = [], source, nowMs }) {
    if (typeof entityId !== "string" || !entityId) fail(REASONS.INVALID_RECORD, "entityId wajib string");
    if (typeof entityKind !== "string" || !entityKind) fail(REASONS.INVALID_RECORD, "entityKind wajib string");
    if (typeof source !== "string" || !source) fail(REASONS.INVALID_RECORD, "source wajib string (untuk kuota WM-A6)");

    return Object.freeze({
        entityId, entityKind: entityKind.slice(0, 64),
        labels: validateLabels(labels),
        firstSeenAt: nowMs, lastSeenAt: nowMs,
        externalRefs: Object.freeze((externalRefs ?? []).slice(0, 32)
            .map(r => Object.freeze({ system: String(r.system).slice(0, 64), id: String(r.id).slice(0, 200) }))),
        source
    });
}

function makeRelation({ relationId, kind, from, to, directed = true, strength = 0.5 }) {
    if (typeof relationId !== "string" || !relationId) fail(REASONS.INVALID_RECORD, "relationId wajib string");
    if (typeof from !== "string" || typeof to !== "string") fail(REASONS.INVALID_RECORD, "from/to wajib entityId string");
    return Object.freeze({
        relationId, kind: String(kind).slice(0, 64), from, to,
        directed: Boolean(directed), strength: clamp01(Number(strength))
    });
}

/** W-2/W-3: tier admissible, sensor.sensorId + observedAt wajib ada. */
function makeObservation({ observationId, subject, attribute, value, sensor, frame = null, tier, observedAt }) {
    if (typeof observationId !== "string" || !observationId) fail(REASONS.INVALID_RECORD, "observationId wajib string");
    if (!subject || (typeof subject.entityId !== "string" && typeof subject.relationId !== "string")) {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");

    if (tier === "SIMULATION") {
        fail(REASONS.SIMULATION_NOT_ADMISSIBLE, "rekaman simulasi ditolak di ingest (W-2)");
    }
    if (!ADMISSIBLE_TIERS.has(tier)) {
        fail(REASONS.INADMISSIBLE_TIER, `tier '${tier}' tidak admissible untuk ingest (hanya T1/T2/T4)`);
    }
    if (!sensor || typeof sensor.sensorId !== "string" || !sensor.sensorId) {
        fail(REASONS.MISSING_SENSOR_ID, "sensor.sensorId wajib ada (W-3)");
    }
    if (typeof observedAt !== "string" || !observedAt) {
        fail(REASONS.MISSING_SENSOR_ID, "observedAt wajib ada (W-3)");
    }

    return Object.freeze({
        observationId, subject: Object.freeze({ ...subject }),
        attribute, value: JSON.parse(JSON.stringify(value ?? null)),
        sensor: Object.freeze({
            sensorId: sensor.sensorId,
            modality: sensor.modality ? String(sensor.modality).slice(0, 64) : null,
            calibrationRef: sensor.calibrationRef ? String(sensor.calibrationRef).slice(0, 200) : null
        }),
        frame: frame ? Object.freeze({ kind: String(frame.kind).slice(0, 32), ref: String(frame.ref).slice(0, 200) }) : null,
        tier, observedAt
    });
}

function makeHypothesis({ hypothesisId, subject, attribute, candidateValues, discriminatingProbe = null, expiresAt }) {
    if (typeof hypothesisId !== "string" || !hypothesisId) fail(REASONS.INVALID_RECORD, "hypothesisId wajib string");
    if (!Array.isArray(candidateValues) || candidateValues.length === 0) {
        fail(REASONS.INVALID_RECORD, "candidateValues wajib array tidak kosong");
    }
    return Object.freeze({
        hypothesisId, subject, attribute,
        candidateValues: Object.freeze(candidateValues.slice(0, 16).map(c =>
            Object.freeze({ value: c.value, weight: clamp01(Number(c.weight)) }))),
        discriminatingProbe, expiresAt
    });
}

module.exports = { ADMISSIBLE_TIERS, makeEntity, makeRelation, makeObservation, makeHypothesis };
