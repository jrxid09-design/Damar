const crypto = require("node:crypto");

/**
 * Amplop event tepercaya (§13) + kelas provenance (§12) + util
 * kanonikalisasi/digest (§50, §101).
 *
 * ATURAN INTI: teks bebas (user/model) TIDAK PERNAH menjadi tipe event.
 * Hanya producer terdaftar yang memproduksi kelas mutasi state. Tipe tak
 * dikenal → catatan diagnostik saja, TIDAK bermutasi state otoritatif.
 *
 * SCHEMA v2 (Wave7 shared prerequisite): menambah klasifikasi epistemik
 * tertutup (`epistemicClass`) terpisah dari `provenance`. Hukum:
 * OBSERVED != INFERRED, INFERRED != FACT, PREDICTED != FACT,
 * UNKNOWN != FALSE, CONFIDENCE != TRUTH, PROVENANCE != AUTHORITY.
 * `confidence` tidak pernah menaikkan `epistemicClass`; keduanya field
 * independen. Rantai hash §51 (`sha256Row`, di ContinuityCore) SENGAJA
 * tidak menyertakan `schemaVersion`/`epistemicClass` — menambahkannya akan
 * mengubah hash yang dihitung ulang untuk setiap baris jurnal historis dan
 * merusak `verifyJournalIntegrity()` untuk data lama.
 */

const SCHEMA_VERSION = 2;

/** Versi skema amplop yang dikenal — tertutup; versi lain gagal keras. */
const KNOWN_SCHEMA_VERSIONS = Object.freeze([1, 2]);

/** Kelas provenance §12 — enum tertutup, sudah deklaratif/beku/string-only. */
const PROVENANCE = Object.freeze([
    "SELF_STATE", "OBSERVATION", "USER_CLAIM", "MEMORY",
    "WORKER_CLAIM", "EXTERNAL_SOURCE", "MODEL_HYPOTHESIS",
    "INFERENCE", "SYSTEM_SENSOR", "SYSTEM_EVENT"
].reduce((m, p) => (m[p] = p, m), {}));

/**
 * Kelas epistemik v2 — enum tertutup, TERPISAH dari `provenance` di atas.
 * UNKNOWN adalah warga kelas satu (default konservatif); tidak pernah
 * dinaikkan otomatis oleh confidence tinggi atau oleh sekadar adanya data.
 */
const EPISTEMIC_CLASS = Object.freeze([
    "OBSERVED", "INFERRED", "PREDICTED", "UNKNOWN"
].reduce((m, c) => (m[c] = c, m), {}));

function isEpistemicClass(value) {
    return Object.prototype.hasOwnProperty.call(EPISTEMIC_CLASS, value);
}

/** Batas eksplisit payload amplop — mengikuti konvensi rumah yang sudah
 * ada di `src/manager/schema.js` dan `src/action/intent.js`. */
const ENVELOPE_BOUNDS = Object.freeze({
    MAX_PAYLOAD_DEPTH: 8,
    MAX_PAYLOAD_NODES: 512,
    MAX_PAYLOAD_KEYS: 64,
    MAX_PAYLOAD_KEY_CHARS: 128,
    MAX_PAYLOAD_STRING_CHARS: 1024,
    GLOBAL_MAX_ARRAY_LENGTH: 1024,
    MAX_ENVELOPE_BYTES: 65536
});

const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

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
    correlationId = null, confidence = 1,
    epistemicClass = EPISTEMIC_CLASS.UNKNOWN, clock = null
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

    if (!isEpistemicClass(epistemicClass)) {
        const error = new Error(`ACC: epistemicClass tidak sah: '${epistemicClass}'`);
        error.code = "ACC_INVALID_EPISTEMIC_CLASS";
        throw error;
    }

    const safeConfidence = validateConfidence(confidence);
    const safePayload = assertSafeMetadata(payload, "payload");

    const nowMs = clock ? clock.nowMs() : Date.now();

    const envelope = Object.freeze({
        eventId: crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        type,
        timestamp: new Date(nowMs).toISOString(),
        monotonic: ++seqCounter,
        source: String(source ?? "unknown").slice(0, 120),
        provenance,
        epistemicClass,
        subject: subject ? String(subject).slice(0, 200) : null,
        sessionId: sessionId ? String(sessionId).slice(0, 120) : null,
        missionId: missionId ? String(missionId).slice(0, 120) : null,
        correlationId: correlationId ? String(correlationId).slice(0, 120) : null,
        confidence: safeConfidence,
        payload: deepFreeze(safePayload)
    });

    const byteSize = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (byteSize > ENVELOPE_BOUNDS.MAX_ENVELOPE_BYTES) {
        const error = new Error(
            `ACC: amplop melebihi batas ukuran (${byteSize} > ${ENVELOPE_BOUNDS.MAX_ENVELOPE_BYTES} byte)`);
        error.code = "ACC_ENVELOPE_TOO_LARGE";
        throw error;
    }

    return envelope;
}

/**
 * Validasi confidence v2 — GAGAL KERAS pada nilai tak sah, TIDAK diam-diam
 * di-clamp seperti `clamp01` (yang tetap dipakai modul lain untuk
 * pemotongan skalar generik dan sengaja tidak diubah di sini).
 */
function validateConfidence(value) {
    const x = Number(value);
    if (!Number.isFinite(x)) {
        const error = new Error(`ACC: confidence tidak sah (non-finite): '${value}'`);
        error.code = "ACC_INVALID_CONFIDENCE";
        throw error;
    }
    if (x < 0 || x > 1) {
        const error = new Error(`ACC: confidence di luar batas [0,1]: ${x}`);
        error.code = "ACC_INVALID_CONFIDENCE";
        throw error;
    }
    return x;
}

/**
 * Pagar payload v2 — menolak bentuk berbahaya SEBELUM menyentuh
 * JSON.stringify (yang diam-diam membuang function/Symbol dan memanggil
 * getter). Deteksi siklik berbasis ancestor-stack (bukan "pernah terlihat"),
 * sehingga referensi bersama yang sah (DAG, bukan siklus) tidak ditolak
 * keliru. Mengembalikan salinan struktural aman (setara `structuredCopy`
 * lama) setelah lolos pagar.
 */
function assertSafeMetadata(value, label) {
    walkSafe(value, label, 0, new WeakSet(), { count: 0 });
    return structuredCopy(value);
}

function walkSafe(value, label, depth, stack, budget) {
    if (value === null || value === undefined) return;

    const t = typeof value;

    if (t === "function") rejectMetadata(label, "fungsi tidak diperbolehkan");
    if (t === "symbol") rejectMetadata(label, "Symbol tidak diperbolehkan");
    if (t === "string" && value.length > ENVELOPE_BOUNDS.MAX_PAYLOAD_STRING_CHARS) {
        rejectMetadata(label, "panjang string melebihi batas");
    }
    if (t !== "object") return;

    if (depth > ENVELOPE_BOUNDS.MAX_PAYLOAD_DEPTH) {
        rejectMetadata(label, "kedalaman melebihi batas");
    }
    if (stack.has(value)) {
        rejectMetadata(label, "struktur siklik terdeteksi");
    }

    budget.count += 1;
    if (budget.count > ENVELOPE_BOUNDS.MAX_PAYLOAD_NODES) {
        rejectMetadata(label, "jumlah node melebihi batas");
    }

    if (Array.isArray(value)) {
        if (value.length > ENVELOPE_BOUNDS.GLOBAL_MAX_ARRAY_LENGTH) {
            rejectMetadata(label, "panjang array melebihi batas");
        }
        stack.add(value);
        try {
            for (const item of value) walkSafe(item, label, depth + 1, stack, budget);
        } finally {
            stack.delete(value);
        }
        return;
    }

    // Kontrak data murni: instance kelas (selain object literal) ditolak.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        rejectMetadata(label, "instance kelas tidak diperbolehkan (kontrak data murni)");
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length > ENVELOPE_BOUNDS.MAX_PAYLOAD_KEYS) {
        rejectMetadata(label, "jumlah kunci melebihi batas");
    }

    stack.add(value);
    try {
        for (const key of keys) {
            if (typeof key === "symbol") {
                rejectMetadata(label, "kunci Symbol tidak diperbolehkan");
            }
            if (DANGEROUS_KEYS.includes(key)) {
                rejectMetadata(label, `kunci berbahaya ditolak: '${key}'`);
            }
            if (key.length > ENVELOPE_BOUNDS.MAX_PAYLOAD_KEY_CHARS) {
                rejectMetadata(label, "panjang kunci melebihi batas");
            }

            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (desc && (desc.get || desc.set)) {
                rejectMetadata(label, `properti accessor ditolak tanpa dipanggil: '${key}'`);
            }

            walkSafe(value[key], label, depth + 1, stack, budget);
        }
    } finally {
        stack.delete(value);
    }
}

function rejectMetadata(label, reason) {
    const error = new Error(`ACC: ${label} tidak sah: ${reason}`);
    error.code = "ACC_INVALID_METADATA";
    throw error;
}

/**
 * Normalisasi baris jurnal (v1 atau v2) menjadi pandangan v2 kanonik.
 * KONSERVATIF: baris v1 (schemaVersion hilang atau 1) SELALU menjadi
 * epistemicClass UNKNOWN — tidak pernah menebak OBSERVED/INFERRED dari
 * `provenance` lama, sekalipun tergoda ("jangan menciptakan kepastian").
 * Versi skema tak dikenal gagal keras (tidak pernah diam-diam diturunkan).
 */
function normalizeEnvelopeRecord(row) {
    if (!row || typeof row !== "object") {
        const error = new Error("ACC: baris envelope tidak sah untuk normalisasi");
        error.code = "ACC_INVALID_ENVELOPE_RECORD";
        throw error;
    }

    const rawVersion = row.schemaVersion ?? null;

    if (rawVersion !== null && !KNOWN_SCHEMA_VERSIONS.includes(rawVersion)) {
        const error = new Error(`ACC: schemaVersion tidak dikenal: ${rawVersion}`);
        error.code = "ACC_UNKNOWN_SCHEMA_VERSION";
        throw error;
    }

    if (rawVersion === 2) {
        const epistemicClass = isEpistemicClass(row.epistemicClass)
            ? row.epistemicClass : EPISTEMIC_CLASS.UNKNOWN;
        return { ...row, schemaVersion: 2, epistemicClass };
    }

    return { ...row, schemaVersion: 2, epistemicClass: EPISTEMIC_CLASS.UNKNOWN };
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
    SCHEMA_VERSION, KNOWN_SCHEMA_VERSIONS, PROVENANCE, EVENT_TYPES,
    EPISTEMIC_CLASS, ENVELOPE_BOUNDS,
    isKnownEventType, isEpistemicClass, makeEnvelope, normalizeEnvelopeRecord,
    canonicalJson, sha256, digest, structuredCopy, clamp01
};
