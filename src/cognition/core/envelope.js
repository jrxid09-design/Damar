const crypto = require("node:crypto");

/**
 * Amplop event tepercaya (§13) + kelas provenance (§12) + util
 * kanonikalisasi/digest (§50, §101).
 *
 * ATURAN INTI: teks bebas (user/model) TIDAK PERNAH menjadi tipe event.
 * Hanya producer terdaftar yang memproduksi kelas mutasi state. Tipe tak
 * dikenal → catatan diagnostik saja, TIDAK bermutasi state otoritatif.
 */

const SCHEMA_VERSION = 1;

/** Kelas epistemik §12 — enum tertutup. */
const PROVENANCE = Object.freeze([
    "SELF_STATE", "OBSERVATION", "USER_CLAIM", "MEMORY",
    "WORKER_CLAIM", "EXTERNAL_SOURCE", "MODEL_HYPOTHESIS",
    "INFERENCE", "SYSTEM_SENSOR", "SYSTEM_EVENT"
].reduce((m, p) => (m[p] = p, m), {}));

/** Kelas event yang BOLEH bermutasi state ACC + producer sah-nya. */
const EVENT_TYPES = Object.freeze({
    // continuity (producer: runtime tepercaya / operator)
    IDENTITY_INITIALIZED: { producers: ["acc.continuity"] },
    CONTINUITY_RESTORED: { producers: ["acc.continuity"] },
    CONTINUITY_EPOCH_CREATED: { producers: ["acc.continuity"] },
    BOOT_EPOCH_CREATED: { producers: ["acc.continuity"] },
    SUBSTRATE_CHANGED: { producers: ["acc.substrate"] },
    COMMITMENT_ADDED: { producers: ["operator", "system_policy", "mission"] },
    COMMITMENT_COMPLETED: { producers: ["operator", "system_policy", "mission"] },
    CONSTITUTION_VERSION_CHANGED: { producers: ["operator"] },

    // observasi runtime (producer: adapter foundation)
    TOOL_SUCCEEDED: { producers: ["foundation.adapter"] },
    TOOL_FAILED: { producers: ["foundation.adapter"] },
    PROVIDER_DEGRADED: { producers: ["foundation.adapter"] },
    RESOURCE_PRESSURE: { producers: ["acc.interoception"] },
    INTEROCEPTIVE_SAMPLE: { producers: ["acc.interoception"] },

    // klaim & hipotesis (TIDAK pernah menulis field otoritatif)
    USER_CLAIM_RECEIVED: { producers: ["session.gateway"] },
    MODEL_PROPOSAL_RECEIVED: { producers: ["acc.substrate"] },
    EXPERIENCE_RECORDED: { producers: ["acc.autobiography"] },
    MEMORY_ACTIVATED: { producers: ["acc.autobiography"] },

    // penulisan state-dirinya ACC sendiri (producer: inti ACC saja;
    // user/model tidak pernah memproduksi tipe ini)
    SELF_STATE_UPDATED: { producers: ["acc.core"] },

    // prediksi
    PREDICTION_OPENED: { producers: ["acc.prediction"] },
    PREDICTION_RESOLVED_CORRECT: { producers: ["acc.prediction"] },
    PREDICTION_RESOLVED_INCORRECT: { producers: ["acc.prediction"] }
});

function isKnownEventType(type) {
    return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

let seqCounter = 0;

/**
 * Amplop event. `monotonic` dijamin naik dalam satu proses; saat replay,
 * reducer menghormati urutan jurnal (seq DB) sebagai kebenaran urutan.
 */
function makeEnvelope({
    type, source, provenance, payload = {},
    subject = null, sessionId = null, missionId = null,
    correlationId = null, confidence = 1, clock = null
} = {}) {

    if (!isKnownEventType(type)) {
        const error = new Error(`ACC: tipe event tidak terdaftar: '${type}'`);
        error.code = "ACC_UNKNOWN_EVENT_TYPE";
        throw error;
    }

    if (!PROVENANCE[provenance]) {
        const error = new Error(`ACC: provenance tidak sah: '${provenance}'`);
        error.code = "ACC_UNKNOWN_PROVENANCE";
        throw error;
    }

    const nowMs = clock ? clock.nowMs() : Date.now();

    return Object.freeze({
        eventId: crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        type,
        timestamp: new Date(nowMs).toISOString(),
        monotonic: ++seqCounter,
        source: String(source ?? "unknown").slice(0, 120),
        provenance,
        subject: subject ? String(subject).slice(0, 200) : null,
        sessionId: sessionId ? String(sessionId).slice(0, 120) : null,
        missionId: missionId ? String(missionId).slice(0, 120) : null,
        correlationId: correlationId ? String(correlationId).slice(0, 120) : null,
        confidence: clamp01(Number(confidence)),
        payload: deepFreeze(structuredCopy(payload))
    });
}

/** JSON kanonik: key terurut deterministik (§50/§101 anti-kebetulan urutan). */
function canonicalJson(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map(k =>
        `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function digest(state) {
    return sha256(canonicalJson(state));
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }

    for (const key of Object.keys(value)) {
        deepFreeze(value[key]);
    }

    return Object.freeze(value);
}

function structuredCopy(value) {
    return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

function clamp01(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.min(1, Math.max(0, x));
}

module.exports = {
    SCHEMA_VERSION, PROVENANCE, EVENT_TYPES,
    isKnownEventType, makeEnvelope,
    canonicalJson, sha256, digest, structuredCopy, clamp01
};


