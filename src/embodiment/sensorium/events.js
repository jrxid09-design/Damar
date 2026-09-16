/**
 * Sensorium — amplop event (B§5, revisi v1).
 *
 * GAGAL-TUTUP: tipe/provenance/subjek/sumber yang tidak dikenal ditolak
 * saat konstruksi maupun pemeriksaan bentuk.
 *
 * PERLINDUNGAN EVENT INTI: tipe kelas "core" tidak bisa dibuat lewat
 * makeEvent() publik sama sekali. Satu-satunya jalan adalah
 * makeCoreEvent() — pabrik INTERNAL yang membubuhkan CORE_TOKEN, simbol
 * privat modul ini (tidak diekspor lewat pintu publik embodiment).
 * ingest() menolak event inti tanpa token: penyamaan string
 * "sensorium.core" saja tidak pernah cukup untuk memalsukan kepercayaan.
 */

const crypto = require("node:crypto");
const { deepFreeze, structuredCopy, clamp01, fail, isProxyValue } = require("../core/util");
const { validateDeviceId } = require("../core/identity");

const SCHEMA_VERSION = 1;

/** Sumber turunan internal sensorium — satu-satunya produsen event inti. */
const CORE_SOURCE = "sensorium.core";

/**
 * Token kapabilitas inti — simbol PRIVAT modul. Sengaja TIDAK diekspor
 * dari src/embodiment/index.js; objek eksternal tidak mungkin memilikinya.
 */
const CORE_TOKEN = Symbol("embodiment.sensorium.core");

const PROVENANCES = Object.freeze([
    "SYSTEM_SENSOR", "OBSERVATION", "EXTERNAL_SOURCE", "SYSTEM_EVENT"
].reduce((m, p) => (m[p] = p, m), {}));

/** Provenance cadangan jalur inti — adapter eksternal tidak boleh memakai. */
const RESERVED_PROVENANCES = Object.freeze(new Set(["SYSTEM_EVENT"]));

/**
 * Tipe event tertutup. producerClass:
 *   "adapter" — hanya discovery adapter terdaftar yang boleh memproduksi
 *   "core"    — hanya sensorium.core bertoken (turunan/kebijakan operator)
 */
const EVENT_TYPES = Object.freeze({
    DEVICE_DISCOVERED: { producerClass: "adapter" },
    DEVICE_REMOVED: { producerClass: "adapter" },
    DEVICE_CHANGED: { producerClass: "adapter" },
    DEVICE_ONLINE: { producerClass: "adapter" },
    DEVICE_OFFLINE: { producerClass: "adapter" },
    DEVICE_HEALTH_CHANGED: { producerClass: "adapter" },
    CAPABILITY_DISCOVERED: { producerClass: "adapter" },
    SENSOR_OBSERVATION: { producerClass: "adapter" },

    // Turunan — TIDAK bisa dikonstruksi dari luar modul:
    DEVICE_DEFAULT_CHANGED: { producerClass: "core" },
    UNKNOWN_DEVICE_REQUIRES_ANALYSIS: { producerClass: "core" }
});

function isKnownEventType(type) {
    return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

let seqCounter = 0;

function commonValidation({ type, source, provenance, subject, payload }) {

    if (!isKnownEventType(type)) {
        throw fail("EMB_UNKNOWN_EVENT_TYPE",
            `tipe event tidak terdaftar: '${type}'`);
    }
    if (!PROVENANCES[provenance]) {
        throw fail("EMB_UNKNOWN_PROVENANCE",
            `provenance tidak sah: '${provenance}'`);
    }
    if (typeof source !== "string" || !/^[^\s]{1,120}$/.test(source)) {
        throw fail("EMB_INVALID_SOURCE",
            "sumber event wajib string 1..120 tanpa spasi");
    }
    if (!validateDeviceId(subject)) {
        throw fail("EMB_INVALID_SUBJECT",
            `subjek event bukan deviceId kanonik: '${String(subject).slice(0, 60)}'`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw fail("EMB_INVALID_PAYLOAD", "payload wajib objek");
    }
}

function buildEnvelope({
    type, source, provenance, subject, payload = {}, confidence = 1, clock = null,
    core = false
}) {

    commonValidation({ type, source, provenance, subject, payload });

    if (!core && EVENT_TYPES[type].producerClass === "core") {
        // Pintu publik tidak pernah bisa menciptakan event inti.
        throw fail("EMB_CORE_EVENT_PROTECTED",
            `tipe '${type}' hanya dapat diproduksi jalur internal sensorium`);
    }

    const nowMs = clock ? clock.nowMs() : Date.now();

    const envelope = {
        eventId: crypto.randomUUID(),
        schemaVersion: SCHEMA_VERSION,
        type,
        timestamp: new Date(nowMs).toISOString(),
        timestampMs: nowMs,
        monotonic: ++seqCounter,
        source: String(source).slice(0, 120),
        provenance,
        subject,
        confidence: clamp01(confidence),
        payload: deepFreeze(structuredCopy(payload))
    };

    return Object.freeze(
        core ? { ...envelope, [CORE_TOKEN]: CORE_TOKEN } : envelope);
}

/** Amplop event adapter/publik. Melempar (gagal-tutup) pada input kotor. */
function makeEvent(options) {
    return buildEnvelope(options);
}

/**
 * Pabrik event inti — INTERNAL saja (tidak diekspor lewat pintu publik
 * embodiment). Membubuhkan CORE_TOKEN yang tak-dapat-dipalsukan objek
 * luar; ingest menolak event inti tanpa token ini.
 */
function makeCoreEvent({ type, subject, payload, clock }) {
    return buildEnvelope({
        type, source: CORE_SOURCE, provenance: "SYSTEM_EVENT",
        subject, payload, confidence: 1, clock, core: true
    });
}

const ENVELOPE_FIELDS = Object.freeze([
    "eventId", "schemaVersion", "type", "timestamp", "timestampMs",
    "monotonic", "source", "provenance", "subject", "confidence", "payload"
]);

/**
 * Batas biaya sanitasi input hostil (kedalaman/lebar/jumlah simpul).
 *
 * Nilai-nilai ini adalah PLAFON anti-DoS murni, sengaja jauh di atas
 * apa pun yang bisa lolos batas sampel 2.048 byte yang sudah dibekukan
 * di BodySchema — jadi tidak mungkin menolak muatan yang sah menurut
 * kontrak. Batas kedalaman sampel yang sebenarnya ditegakkan oleh batas
 * byte itu sendiri, bukan oleh angka di sini.
 */
const MAX_SANITIZE_DEPTH = 64;
const MAX_SANITIZE_KEYS = 4096;
const MAX_SANITIZE_NODES = 65536;

/** `__proto__` tidak pernah data sah dan selalu berbahaya via assignment. */
const FORBIDDEN_KEYS = Object.freeze(new Set(["__proto__"]));

/**
 * Pemeriksaan Proxy lewat internal slot — TIDAK memicu trap apa pun dan
 * tetap benar untuk Proxy yang sudah dicabut. Kegagalan probe diperlakukan
 * sebagai "proxy" (gagal-tutup).
 */
function isProxy(value) {
    return isProxyValue(value);
}

/**
 * Salinan-dalam SADAR-DESKRIPTOR untuk batas kepercayaan ingest.
 *
 * Event dari jurnal/antrean/pemanggil asing tidak pernah melewati
 * `makeEvent()`, sehingga field bersarang bisa berupa accessor hidup atau
 * `toJSON` yang dapat dieksekusi. Fungsi ini MEMBACA VIA DESKRIPTOR saja:
 * `[[Get]]` tidak pernah dipanggil, jadi getter tidak pernah berjalan dan
 * `toJSON` tidak pernah dipakai (kontras dengan `structuredCopy`).
 *
 * PROXY DITOLAK SEBELUM TRAP PERTAMA: `util.types.isProxy()` adalah
 * pemeriksaan internal-slot yang tidak memicu trap apa pun — termasuk pada
 * Proxy yang sudah dicabut. Tanpa ini, `ownKeys`/`getOwnPropertyDescriptor`
 * justru MENJALANKAN kode pemanggil, yang persis berlawanan dengan tujuan
 * fungsi ini. Pola yang sama dipakai modul ingress/otorisasi lain di repo.
 *
 * Properti yang diwarisi dari prototipe TIDAK disalin — field otoritas
 * selundupan lewat rantai prototipe hilang dengan sendirinya.
 * Accessor, simbol asing, fungsi/simbol/bigint, serta array ber-properti
 * tambahan ditolak alih-alih disalin.
 */
function sanitizeDeep(value, depth, budget, inPayload = false) {
    if (budget.n <= 0) throw fail("EMB_EVENT_TOO_COMPLEX", "amplop event terlalu kompleks");
    budget.n -= 1;

    if (value === null) return null;
    const kind = typeof value;
    if (kind === "string" || kind === "number" || kind === "boolean") return value;
    if (kind === "undefined") return undefined;
    if (kind !== "object") {
        // fungsi/simbol/bigint: material yang tidak boleh menyeberang batas
        throw fail("EMB_INVALID_EVENT_VALUE",
            "nilai amplop event tidak dapat disanitasi");
    }
    if (isProxy(value)) {
        throw fail("EMB_INVALID_EVENT_VALUE",
            "amplop event tidak boleh berupa Proxy");
    }
    if (depth >= MAX_SANITIZE_DEPTH) {
        throw fail("EMB_EVENT_TOO_DEEP", "kedalaman amplop event melebihi batas");
    }

    let symbols, names;
    try {
        symbols = Object.getOwnPropertySymbols(value);
        names = Object.getOwnPropertyNames(value);
    } catch {
        throw fail("EMB_INVALID_EVENT_VALUE",
            "amplop event tidak dapat diperiksa dengan aman");
    }
    for (const sym of symbols) {
        if (sym !== CORE_TOKEN) {
            throw fail("EMB_INVALID_EVENT_VALUE", "amplop event tidak boleh membawa simbol");
        }
    }
    if (names.length > MAX_SANITIZE_KEYS) {
        throw fail("EMB_EVENT_TOO_WIDE", "lebar amplop event melebihi batas");
    }

    const isArray = Array.isArray(value);
    let out;
    if (isArray) {
        const lengthDesc = Object.getOwnPropertyDescriptor(value, "length");
        const n = lengthDesc && "value" in lengthDesc ? lengthDesc.value : null;
        if (!Number.isSafeInteger(n) || n < 0) {
            throw fail("EMB_INVALID_EVENT_VALUE", "panjang array tidak sah");
        }
        // Indeks saja — properti tambahan pada array adalah material tersembunyi.
        if (names.length !== n + 1) {
            throw fail("EMB_INVALID_EVENT_VALUE",
                "array amplop event tidak boleh membawa properti tambahan");
        }
        out = new Array(n);
    } else {
        out = {};
    }

    for (const key of names) {
        if (key === "length") continue;
        if (FORBIDDEN_KEYS.has(key)) {
            throw fail("EMB_INVALID_EVENT_VALUE",
                `field '${key}' tidak sah pada amplop event`);
        }
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(value, key);
        } catch {
            throw fail("EMB_INVALID_EVENT_VALUE",
                `field '${String(key)}' tidak dapat diperiksa dengan aman`);
        }
        if (!desc) continue;
        if (desc.get || desc.set) {
            // Kode alasan dipertahankan per-asal: accessor di dalam
            // `payload` tetap melaporkan kode validasi payload yang sudah
            // ada, sisanya memakai kode amplop.
            const code = inPayload
                ? "EMB_INVALID_OBSERVATION_PAYLOAD"
                : "EMB_INVALID_EVENT_ACCESSOR";
            throw fail(code,
                `field '${String(key)}' tidak boleh berupa accessor`);
        }
        if (desc.enumerable === false) {
            throw fail("EMB_INVALID_EVENT_VALUE",
                `field '${String(key)}' wajib enumerable`);
        }
        const childInPayload = inPayload || (depth === 0 && key === "payload");
        // defineProperty, bukan assignment: assignment ke nama warisan
        // seperti `__proto__` menulis ke rantai prototipe, bukan ke objek.
        Object.defineProperty(out, key, {
            value: sanitizeDeep(desc.value, depth + 1, budget, childInPayload),
            writable: true, enumerable: true, configurable: true
        });
    }

    for (const sym of symbols) {
        const desc = Object.getOwnPropertyDescriptor(value, sym);
        if (desc && !desc.get && !desc.set && desc.value === CORE_TOKEN) {
            Object.defineProperty(out, sym, {
                value: CORE_TOKEN, writable: true, enumerable: true, configurable: true
            });
        }
    }

    return out;
}

/**
 * Batas kepercayaan ingest: menyalin amplop secara aman lalu memvalidasi
 * bentuknya. Mengembalikan salinan beku yang dapat dipakai seluruh jalur
 * plan/commit tanpa pernah menyentuh objek pemanggil lagi.
 */
function sanitizeEnvelope(event) {
    if (!event || typeof event !== "object") {
        return { ok: false, reason: "event-bukan-objek" };
    }

    let clean;
    try {
        clean = sanitizeDeep(event, 0, { n: MAX_SANITIZE_NODES });
    } catch (err) {
        return { ok: false, reason: (err && err.code) || "event-tidak-dapat-disitir" };
    }

    const missing = ENVELOPE_FIELDS.find(
        (field) => !Object.prototype.hasOwnProperty.call(clean, field));
    if (missing) return { ok: false, reason: `field-hilang:${missing}` };

    // Amplop bersifat TERTUTUP: field tingkat-atas di luar daftar kanonik
    // adalah material asing, bukan data event yang sah.
    const extra = Object.keys(clean).find((key) => !ENVELOPE_FIELDS.includes(key));
    if (extra) return { ok: false, reason: `field-asing:${extra}` };

    if (!isKnownEventType(clean.type)) {
        return { ok: false, reason: `tipe-tak-dikenal:${String(clean.type)}` };
    }
    if (!PROVENANCES[clean.provenance]) {
        return { ok: false, reason: `provenance-tak-dikenal:${String(clean.provenance)}` };
    }
    if (typeof clean.source !== "string" || !/^[^\s]{1,120}$/.test(clean.source)) {
        return { ok: false, reason: "sumber-tidak-sah" };
    }
    if (!validateDeviceId(clean.subject)) {
        return { ok: false, reason: "subjek-tidak-sah" };
    }
    if (!Number.isInteger(clean.monotonic) || !Number.isFinite(clean.timestampMs)) {
        return { ok: false, reason: "urutan/waktu-tidak-sah" };
    }
    if (!Number.isFinite(Number(clean.confidence))) {
        return { ok: false, reason: "confidence-tidak-sah" };
    }
    if (!clean.payload || typeof clean.payload !== "object") {
        return { ok: false, reason: "payload-tidak-sah" };
    }

    return { ok: true, event: deepFreeze(clean) };
}

/**
 * Pemeriksaan bentuk non-meletup untuk sisi ingest. Event dari dunia
 * luar (jurnal, antrean, pemanggil asing) bisa korup/dipalsukan;
 * ingest harus bisa MENOLAK tanpa menghentikan proses.
 *
 * Memakai jalur sanitasi yang sama dengan `ingest()` supaya pemeriksaan
 * bentuk maupun penerapan TIDAK PERNAH mengeksekusi kode pemanggil.
 */
function validateEventShape(event) {
    const result = sanitizeEnvelope(event);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

module.exports = {
    SCHEMA_VERSION, CORE_SOURCE, PROVENANCES, RESERVED_PROVENANCES,
    EVENT_TYPES, CORE_TOKEN,
    isKnownEventType, makeEvent, makeCoreEvent, validateEventShape,
    sanitizeEnvelope
};
