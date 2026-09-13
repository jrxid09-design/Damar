"use strict";

/** W7-L4 PROSPECTIVE MEMORY — pembangun record murni (spec §3). */

const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

const WAKE_CLASSES = new Set(["NOTIFY_OWNER", "RESUME_GOAL", "CHECK_EXPECTATION", "MAINTENANCE"]);
// Bug review independen (audit putaran-18, AUD18-P2-2): "ON_EVENT" diterima
// TRIGGER_KINDS dan divalidasi, tapi tidak ada jalur dispatch untuknya di
// mana pun (index.js's tick()/checkOnStateReminders() hanya menangani
// AT/AFTER/RECURRING/ON_STATE) -- sebuah reminder ON_EVENT yang diterima
// PERMANEN macet di state ARMED, menghabiskan MAX_ARMED_REMINDERS
// selamanya (dan bertahan lewat restart karena reminder itu durabel).
// Ditolak tertutup sampai jalur dispatch-nya benar-benar diimplementasikan.
const TRIGGER_KINDS = new Set(["AT", "AFTER", "RECURRING", "ON_STATE"]);

/** PM-A3: recurrence tanpa batas ditolak — wajib until ATAU maxOccurrences, dan ada lantai periode. */
function validateTrigger(trigger) {
    if (!trigger || !TRIGGER_KINDS.has(trigger.kind)) {
        fail(REASONS.INVALID_TRIGGER, `trigger.kind '${trigger?.kind}' tidak dikenal`);
    }
    if (trigger.kind === "AT") {
        if (typeof trigger.at !== "string" || !Number.isFinite(Date.parse(trigger.at))) {
            fail(REASONS.INVALID_TRIGGER, "trigger AT wajib 'at' ISO string sah");
        }
    }
    if (trigger.kind === "AFTER") {
        if (!Number.isFinite(trigger.delayMs) || trigger.delayMs <= 0) {
            fail(REASONS.INVALID_TRIGGER, "trigger AFTER wajib delayMs > 0");
        }
    }
    if (trigger.kind === "RECURRING") {
        if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs < BOUNDS.MIN_RECURRENCE_INTERVAL_MS) {
            fail(REASONS.RECURRENCE_PERIOD_TOO_SHORT,
                `interval recurring di bawah lantai ${BOUNDS.MIN_RECURRENCE_INTERVAL_MS}ms`);
        }
        const hasUntil = typeof trigger.until === "string" && Number.isFinite(Date.parse(trigger.until));
        const hasMax = Number.isFinite(trigger.maxOccurrences) && trigger.maxOccurrences > 0;
        if (!hasUntil && !hasMax) {
            fail(REASONS.RECURRENCE_UNBOUNDED, "recurring wajib 'until' atau 'maxOccurrences'");
        }
        if (hasMax && trigger.maxOccurrences > BOUNDS.MAX_RECURRENCE_OCCURRENCES) {
            fail(REASONS.RECURRENCE_UNBOUNDED, `maxOccurrences melebihi batas (${BOUNDS.MAX_RECURRENCE_OCCURRENCES})`);
        }
    }
    if (trigger.kind === "ON_STATE" && (typeof trigger.subject !== "object" || typeof trigger.attribute !== "string")) {
        fail(REASONS.INVALID_TRIGGER, "trigger ON_STATE wajib subject/attribute");
    }
    // Bug review independen (audit putaran-8, W7R8-P2-2; diperdalam putaran-9,
    // AUD9-P2-1): `Object.freeze({...trigger.subject})` cuma satu level --
    // objek bersarang di dalam subject tetap referensi milik pemanggil.
    // deepFreeze menutup ini di semua kedalaman.
    // Bug review independen (audit putaran-11, AUD11-P2-1; diperdalam
    // putaran-12, AUD12-P1-1): perbaikan putaran-11 hanya membungkus
    // `trigger.subject` -- field LAIN pada trigger ON_STATE (mis. `extra`,
    // `predicate`) tetap referensi mentah milik pemanggil, tidak disaring
    // ATAU dibekukan sama sekali (beda dengan cabang non-ON_STATE di bawah
    // yang sudah membungkus SELURUH trigger). Sekarang seluruh trigger
    // dibungkus juga, sama seperti cabang lain.
    if (trigger.kind === "ON_STATE") {
        return deepFreeze(buildSafePayloadRef({ ...trigger, subject: { ...trigger.subject } }));
    }
    // Bug review independen (audit putaran-10, AUD10-P2-2): sapuan deepFreeze
    // putaran-9 hanya menyentuh cabang ON_STATE -- cabang lain (AT/AFTER/
    // RECURRING/ON_EVENT) masih pembekuan SATU level, objek/nilai bersarang
    // apa pun yang pemanggil sisipkan di trigger tetap referensi mutable.
    return deepFreeze(buildSafePayloadRef({ ...trigger }));
}

const FORBIDDEN_PAYLOAD_KEYS = Object.freeze(["capabilityId", "actuatorRef", "authProof", "authorityDecision", "intentTemplate"]);
const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;

const MAX_PAYLOAD_SCAN_DEPTH = 16;
const MAX_PAYLOAD_KEYS = 256;
const MAX_PAYLOAD_NODES = 512;

/**
 * PM-1: satu lintasan yang MEMVALIDASI dan MEMBANGUN salinan aman sekaligus
 * -- bukan lagi validasi lalu JSON.stringify terpisah. Bug diketemukan
 * review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * putaran-3, AUD3-P1-1): bahkan setelah prototype/accessor/fungsi diperiksa
 * lewat Reflect.ownKeys/getOwnPropertyDescriptor, sebuah `Proxy` bisa
 * membuat trap `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor`
 * konsisten-tapi-bohong (melaporkan bentuk aman), sementara trap `get`-nya
 * mengembalikan `toJSON` tersembunyi yang lalu dipanggil JSON.stringify di
 * langkah copy terpisah -- toJSON itu memalsukan capabilityId/authProof.
 * Perbaikan: TIDAK PERNAH membaca nilai lewat `value[key]` (itu memanggil
 * trap `get`); selalu baca dari `desc.value` (hasil `getOwnPropertyDescriptor`
 * yang SUDAH final) dan bangun objek/array polos baru langsung dari situ.
 * `JSON.stringify` tidak pernah lagi dipanggil pada objek pemanggil yang
 * tidak tepercaya -- hanya pada salinan aman yang sudah kita bangun sendiri.
 */
function buildSafePayloadRef(value, depth = 0, budget) {
    // Bug review independen (audit putaran-14, AUD14-P1-1): walker ini tidak
    // punya anggaran jumlah node seperti worldmodel's buildSafeBeliefValue
    // (W7R5-P1-2) -- sebuah DAG referensi-bersama (BUKAN siklus, jadi lolos
    // MAX_PAYLOAD_SCAN_DEPTH) dengan fanout kecil meledak eksponensial
    // (fan^depth salinan), CPU/memory DoS trivial lewat arm/armExpectation.
    // `budget` diwariskan rekursif sepanjang SATU panggilan.
    if (!budget) budget = { count: 0 };
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa Symbol");
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa BigInt");
    if (t !== "object") return value;
    if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    budget.count += 1;
    if (budget.count > MAX_PAYLOAD_NODES) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node pada payloadRef melebihi batas");
    }

    if (Array.isArray(value)) {
        if (value.length > BOUNDS.MAX_PAYLOAD_ARRAY_LENGTH) {
            fail(REASONS.PAYLOAD_TOO_LARGE, "panjang array pada payloadRef melebihi batas");
        }
        const arrProto = Object.getPrototypeOf(value);
        if (arrProto !== Array.prototype && arrProto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED,
                "payloadRef tidak boleh berupa array dengan prototype non-standar (kontrak data murni, termasuk toJSON warisan)");
        }
        const out = [];
        for (let i = 0; i < value.length; i++) {
            const desc = Object.getOwnPropertyDescriptor(value, i);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa properti accessor: '${i}'`);
            }
            const built = buildSafePayloadRef(desc.value, depth + 1, budget);
            out[i] = built === undefined ? null : built; // sama seperti JSON: lubang array -> null
        }
        // Properti OWN non-indeks pada array (mis. `.toJSON`) divalidasi
        // tapi TIDAK disalin -- sama seperti JSON.stringify lama yang diam-diam
        // mengabaikan properti non-indeks pada array.
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length" || ARRAY_INDEX_PATTERN.test(String(key))) continue;
            if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa kunci Symbol");
            if (DANGEROUS_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak pada array: '${key}'`);
            if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa '${key}' (di kedalaman manapun)`);
            }
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa properti accessor: '${String(key)}'`);
            }
            // Nilainya tidak disalin (lihat komentar di atas), TAPI tetap
            // divalidasi -- kalau tidak, `arr.toJSON = fn` lolos tanpa
            // terdeteksi karena tidak pernah masuk `out`.
            buildSafePayloadRef(desc.value, depth + 1, budget);
        }
        return out;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED,
            "payloadRef tidak boleh berupa instance kelas (kontrak data murni, termasuk toJSON warisan)");
    }
    const objKeys = Reflect.ownKeys(value);
    if (objKeys.length > MAX_PAYLOAD_KEYS) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah kunci pada payloadRef melebihi batas");
    }
    const out = {};
    for (const key of objKeys) {
        if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh membawa kunci Symbol");
        if (DANGEROUS_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
        if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa '${key}' (di kedalaman manapun)`);
        }
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc || desc.get || desc.set) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `payloadRef tidak boleh membawa properti accessor: '${String(key)}'`);
        }
        const built = buildSafePayloadRef(desc.value, depth + 1, budget);
        if (built !== undefined) out[key] = built; // sama seperti JSON: kunci bernilai undefined dibuang
    }
    return out;
}

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * putaran-3, AUD3-P1-2): versi lama berhenti rekursi begitu `Object.isFrozen`
 * true, jadi node perantara yang SUDAH beku milik pemanggil melindungi anak
 * yang masih bisa diubah; dan `Object.keys` melewati properti non-enumerable
 * walau assertSafePayloadRef sudah memvalidasinya lewat Reflect.ownKeys.
 * Sekarang selalu rekursi lewat Reflect.ownKeys, pakai WeakSet untuk
 * menghindari siklus (bukan status frozen).
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

/** PM-1: payloadRef adalah REFERENSI saja — menolak materi eksekusi/fungsi. */
function validatePayloadRef(payloadRef) {
    if (payloadRef === null || payloadRef === undefined) return null;
    const safeCopy = buildSafePayloadRef(payloadRef);
    // Aman dipanggil di sini: safeCopy adalah struktur polos yang KITA
    // bangun sendiri di atas -- tidak ada lagi proxy/accessor/toJSON warisan
    // yang bisa dieksekusi JSON.stringify.
    const serialized = JSON.stringify(safeCopy);
    if (serialized === undefined) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak dapat diserialisasi");
    if (Buffer.byteLength(serialized) > BOUNDS.MAX_PAYLOAD_REF_BYTES) {
        fail(REASONS.PAYLOAD_TOO_LARGE, "payloadRef melebihi batas ukuran");
    }
    return deepFreeze(safeCopy);
}

function makeReminder({ reminderId, ownerRef = null, trigger, payloadRef = null, wakeClass, origin = { kind: "SELF" }, nowIso }) {
    if (typeof reminderId !== "string" || !reminderId) fail(REASONS.INVALID_RECORD, "reminderId wajib string");
    if (!WAKE_CLASSES.has(wakeClass)) fail(REASONS.INVALID_RECORD, `wakeClass '${wakeClass}' tidak dikenal`);
    // Bug review independen (audit putaran-12, AUD12-P2-3): ownerRef
    // diteruskan mentah tanpa disaring -- BigInt di dalamnya meledakkan
    // JSON.stringify saat persist().
    if (ownerRef !== null && (typeof ownerRef !== "string" || !ownerRef)) {
        fail(REASONS.INVALID_RECORD, "ownerRef, jika ada, wajib string");
    }

    return Object.freeze({
        reminderId, ownerRef,
        trigger: validateTrigger(trigger),
        payloadRef: validatePayloadRef(payloadRef),
        // Bug review independen (audit putaran-11, AUD11-P2-1): deepFreeze
        // hanya membekukan, tidak menyaring -- BigInt di dalam origin lolos
        // lalu meledakkan JSON.stringify di saveSnapshot() saat persist().
        // buildSafePayloadRef menyaring BigInt/function/Symbol sekaligus.
        wakeClass, origin: deepFreeze(buildSafePayloadRef({ ...origin })),
        state: "ARMED", firedAt: null, missedAt: null, retiredReason: null,
        occurrenceIndex: 0, armedAtMs: null, createdAt: nowIso
    });
}

function makeExpectation({ expectationId, subject, attribute, expectedValue, window, onSatisfied = "CLOSE", onViolated = "NOTIFY" }) {
    if (typeof expectationId !== "string" || !expectationId) fail(REASONS.INVALID_RECORD, "expectationId wajib string");
    if (!window || typeof window.latestAt !== "string" || !Number.isFinite(Date.parse(window.latestAt))) {
        // PM-5: ekspektasi tanpa latestAt YANG SAH ditolak. Bug diketemukan
        // review independen (Codex, putaran ke-4): string tak-tanggal lolos
        // dulu, lalu Date.parse -> NaN membuat checkExpectations() tidak
        // pernah bisa melewati window (tidak pernah VIOLATED).
        fail(REASONS.NO_LATEST_AT, "window.latestAt wajib tanggal ISO yang sah (PM-5)");
    }
    if (window.earliestAt !== undefined && window.earliestAt !== null &&
        !Number.isFinite(Date.parse(window.earliestAt))) {
        fail(REASONS.NO_LATEST_AT, "window.earliestAt, jika ada, wajib tanggal ISO yang sah");
    }
    // Bug review independen (audit putaran-12, AUD12-P2-3): attribute/
    // onSatisfied/onViolated diteruskan mentah tanpa disaring -- BigInt di
    // salah satunya meledakkan JSON.stringify saat persist().
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");
    if (typeof onSatisfied !== "string") fail(REASONS.INVALID_RECORD, "onSatisfied wajib string");
    if (typeof onViolated !== "string") fail(REASONS.INVALID_RECORD, "onViolated wajib string");
    // Bug review independen (audit putaran-9, AUD9-P2-3): expectedValue
    // tidak pernah disaring -- BigInt di dalamnya lolos lalu meledakkan
    // JSON.stringify di saveSnapshot() saat persist(). buildSafePayloadRef
    // sudah menolak BigInt/function/authority-shaped keys; dipakai ulang di sini.
    // Bug review independen (audit putaran-10, AUD10-P1-1): salinan yang
    // dikembalikan buildSafePayloadRef tidak pernah dibekukan di sini --
    // tetap bisa dimutasi pemanggil pasca-panggilan.
    // Bug review independen (audit putaran-11, AUD11-P2-1): subject/window di
    // sini juga cuma deepFreeze (membekukan, tidak menyaring) -- BigInt di
    // dalamnya lolos lalu meledakkan JSON.stringify di saveSnapshot().
    return Object.freeze({
        expectationId, subject: deepFreeze(buildSafePayloadRef({ ...subject })), attribute,
        expectedValue: deepFreeze(buildSafePayloadRef(expectedValue)),
        window: deepFreeze(buildSafePayloadRef({ ...window })),
        onSatisfied, onViolated, state: "PENDING"
    });
}

function makeWakeEvent({ reminderId, wakeClass, payloadRef, firedAt, occurrenceId, lateness = 0, missed = false }) {
    // PM-1: tidak ada capabilityId/actuatorRef/intent di sini secara struktural.
    return Object.freeze({
        reminderId, wakeClass, payloadRef, firedAt, occurrenceId, lateness, missed
    });
}

module.exports = {
    WAKE_CLASSES, TRIGGER_KINDS, validateTrigger, validatePayloadRef,
    makeReminder, makeExpectation, makeWakeEvent
};
