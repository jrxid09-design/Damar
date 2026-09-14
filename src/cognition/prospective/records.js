"use strict";

/** W7-L4 PROSPECTIVE MEMORY — pembangun record murni (spec §3). */

const { REASONS, fail, ProspectiveError } = require("./errors");
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
    // Bug review independen (audit putaran-33, AUD33-P2-4; putaran-34,
    // AUD34-P2-2/AUD34-P2-4): fungsi ini punya riwayat baca-berkali-kali
    // yang paling gigih di seluruh basis kode. Putaran-33 mengeluarkan
    // `subject` ITU SENDIRI lewat destructuring, tapi guard `kind` masih
    // membaca `trigger.kind` LANGSUNG (baca pertama) SEBELUM destructuring
    // (baca kedua) sempat menangkapnya ke lokal -- persis jebakan yang
    // sama yang tertangkap round INI JUGA lewat tes sendiri sebelum commit
    // (bukan cuma spread-lalu-override, tapi juga guard-lalu-destructure).
    // `kind` (dan `entityId`/`relationId` di dalam subject, kelas yang
    // sama dengan AUD34-P2-1 di goals/records.js) sekarang dikeluarkan
    // SEKALI lewat destructuring TERLEBIH DAHULU, baru divalidasi dari
    // lokal itu -- `trigger`/`subject` mentah tidak pernah disentuh lagi
    // setelah baris ini.
    // Bug review independen (audit putaran-37, AUD37-P2-2): destructuring
    // `subject` di atas dulu diangkat TANPA SYARAT ke bagian paling atas
    // fungsi ini supaya ON_STATE dapat satu baca -- tapi itu berarti
    // trigger AT/AFTER/RECURRING (yang TIDAK PERNAH memakai subject) juga
    // ikut membaca entityId/relationId-nya, mengeksekusi accessor
    // pemanggil yang sebelumnya (sebelum putaran-34) tidak pernah
    // tersentuh sama sekali untuk kind selain ON_STATE. `subject` sekarang
    // hanya dikeluarkan di DALAM cabang ON_STATE, tempat ia benar-benar
    // dipakai.
    // Bug review independen (audit putaran-43, W7R43-P2-1): destructuring
    // di bawah membaca SETIAP properti `trigger` lewat [[Get]] biasa --
    // sebuah Proxy yang di-revoke melempar TypeError MENTAH pada operasi
    // ini, keluar dari `arm()` publik, bukan INVALID_TRIGGER terkendali.
    let kind, at, delayMs, intervalMs, until, maxOccurrences, subject, attribute, triggerRest;
    try {
        ({
            kind, at, delayMs, intervalMs, until, maxOccurrences, subject, attribute,
            ...triggerRest
        } = trigger ?? {});
    } catch {
        fail(REASONS.INVALID_TRIGGER, "trigger tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!trigger || !TRIGGER_KINDS.has(kind)) {
        // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
        // `${trigger?.kind}` mentah meledakkan TypeError untuk Symbol.
        const kindType = typeof kind;
        fail(REASONS.INVALID_TRIGGER, `trigger.kind '${kindType === "string" ? kind : kindType}' tidak dikenal`);
    }
    if (kind === "AT") {
        if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
            fail(REASONS.INVALID_TRIGGER, "trigger AT wajib 'at' ISO string sah");
        }
    }
    if (kind === "AFTER") {
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
            fail(REASONS.INVALID_TRIGGER, "trigger AFTER wajib delayMs > 0");
        }
    }
    if (kind === "RECURRING") {
        if (!Number.isFinite(intervalMs) || intervalMs < BOUNDS.MIN_RECURRENCE_INTERVAL_MS) {
            fail(REASONS.RECURRENCE_PERIOD_TOO_SHORT,
                `interval recurring di bawah lantai ${BOUNDS.MIN_RECURRENCE_INTERVAL_MS}ms`);
        }
        const hasUntil = typeof until === "string" && Number.isFinite(Date.parse(until));
        const hasMax = Number.isFinite(maxOccurrences) && maxOccurrences > 0;
        if (!hasUntil && !hasMax) {
            fail(REASONS.RECURRENCE_UNBOUNDED, "recurring wajib 'until' atau 'maxOccurrences'");
        }
        if (hasMax && maxOccurrences > BOUNDS.MAX_RECURRENCE_OCCURRENCES) {
            fail(REASONS.RECURRENCE_UNBOUNDED, `maxOccurrences melebihi batas (${BOUNDS.MAX_RECURRENCE_OCCURRENCES})`);
        }
    }
    // Bug review independen (audit putaran-24, AUD24-P2-4): `typeof
    // trigger.subject !== "object"` TIDAK menolak `null` (typeof null ===
    // "object"), jadi subject:null lolos lalu spread ke `{}` -- ON_STATE
    // reminder tanpa entityId/relationId nyata tersimpan, kolaps lewat
    // subjectKeyOf ke kunci sentinel bersama.
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
    // Bug review independen (audit putaran-37, AUD37-P2-2): `subject`
    // dikeluarkan DI SINI (bukan di atas fungsi) supaya AT/AFTER/RECURRING
    // tidak pernah menyentuhnya sama sekali.
    // Bug review independen (audit putaran-38, AUD38-P2-1): destructuring
    // `entityId`/`relationId` di atas membaca KEDUANYA lewat [[Get]] biasa
    // milik pemanggil SEBELUM buildSafePayloadRef (descriptor-based)
    // sempat memprosesnya -- getter relationId tereksekusi bahkan ketika
    // entityId sudah valid. Disaring SEKALI lewat buildSafePayloadRef
    // lebih dulu; entityId/relationId diturunkan dari salinan aman itu.
    if (kind === "ON_STATE") {
        const safeSubject = buildSafePayloadRef(subject);
        const validEntity = typeof safeSubject?.entityId === "string";
        if (!subject || (!validEntity && typeof safeSubject?.relationId !== "string") ||
            typeof attribute !== "string") {
            fail(REASONS.INVALID_TRIGGER, "trigger ON_STATE wajib subject/attribute");
        }
        return deepFreeze(buildSafePayloadRef({
            ...triggerRest, kind, attribute, subject: safeSubject
        }));
    }
    // Bug review independen (audit putaran-10, AUD10-P2-2): sapuan deepFreeze
    // putaran-9 hanya menyentuh cabang ON_STATE -- cabang lain (AT/AFTER/
    // RECURRING) masih pembekuan SATU level, objek/nilai bersarang apa pun
    // yang pemanggil sisipkan di trigger tetap referensi mutable.
    // (ON_EVENT dihapus dari TRIGGER_KINDS putaran-18, AUD18-P2-2.)
    return deepFreeze(buildSafePayloadRef({ ...triggerRest, kind, at, delayMs, intervalMs, until, maxOccurrences }));
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
    // Bug review independen (audit putaran-31, AUD31-ADV-1): sibling dari
    // worldmodel's buildSafeBeliefValue (AUD30-ADV-1) -- angka non-finite
    // (Infinity/-Infinity/NaN) lolos apa adanya lalu diam-diam berubah
    // jadi `null` saat persist() lewat backend JSON (mis. sqlite).
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak boleh berupa angka non-finite (NaN/Infinity)");
    }
    if (t !== "object") return value;
    if (depth > MAX_PAYLOAD_SCAN_DEPTH) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    budget.count += 1;
    if (budget.count > MAX_PAYLOAD_NODES) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node pada payloadRef melebihi batas");
    }

    // Bug review independen (audit putaran-43, W7R43-P2-1/W7R43-P2-7):
    // `Array.isArray`/`Object.getPrototypeOf`/`Reflect.ownKeys` di bawah
    // adalah operasi dasar terhadap `value` yang belum tepercaya -- di
    // KEDALAMAN MANAPUN lewat rekursi -- sebuah Proxy yang di-revoke
    // melempar TypeError MENTAH pada operasi ini, keluar dari `arm()`/
    // `armExpectation()` publik. Seluruh cabang array/objek dibungkus
    // try/catch; ProspectiveError (termasuk hasil rekursi anak) diteruskan
    // apa adanya, kegagalan APA PUN lainnya gagal tertutup.
    try {
        if (Array.isArray(value)) {
            // Bug review independen (audit putaran-42, W7R42-P2-1): `value.length`
            // dulu dibaca SEKALI untuk cek batas ini, lalu dibaca ULANG di
            // KONDISI loop di bawah setiap iterasi -- Proxy dengan getter
            // `length` yang terus bertambah membuat loop TIDAK PERNAH berhenti
            // (DoS). `length` di-cache SEKALI ke lokal dan divalidasi sebagai
            // integer terhingga non-negatif SEBELUM dipakai di mana pun.
            const len = value.length;
            if (!Number.isInteger(len) || len < 0 || len > BOUNDS.MAX_PAYLOAD_ARRAY_LENGTH) {
                fail(REASONS.PAYLOAD_TOO_LARGE, "panjang array pada payloadRef melebihi batas atau tidak sah");
            }
            const arrProto = Object.getPrototypeOf(value);
            if (arrProto !== Array.prototype && arrProto !== null) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED,
                    "payloadRef tidak boleh berupa array dengan prototype non-standar (kontrak data murni, termasuk toJSON warisan)");
            }
            const out = [];
            for (let i = 0; i < len; i++) {
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
    } catch (err) {
        // Bug review independen (audit putaran-44, W7R44-P2-1): `err
        // instanceof ProspectiveError` memanggil [[GetPrototypeOf]] pada
        // `err` -- sebuah Proxy yang sengaja dilempar dengan trap
        // `getPrototypeOf` yang melempar membuat guard fail-closed ini
        // SENDIRI jadi permukaan raw-throw. Dibungkus try/catch; kegagalan
        // pemeriksaan ini dianggap BUKAN ProspectiveError.
        let isDomainError = false;
        try {
            isDomainError = err instanceof ProspectiveError;
        } catch {
            isDomainError = false;
        }
        if (isDomainError) throw err;
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "payloadRef tidak dapat diverifikasi dengan aman, ditolak");
    }
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
    // Bug review independen (audit putaran-26, AUD26-P2-1): interpolasi
    // `${wakeClass}` mentah meledakkan TypeError untuk Symbol.
    if (!WAKE_CLASSES.has(wakeClass)) fail(REASONS.INVALID_RECORD, `wakeClass '${typeof wakeClass === "string" ? wakeClass : typeof wakeClass}' tidak dikenal`);
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
        // Bug review independen (audit putaran-37, AUD37-P2-3): `{...origin}`
        // men-spread SEBELUM diserahkan ke buildSafePayloadRef -- spread itu
        // sendiri membaca setiap properti enumerable (memanggil getter apa
        // pun) sebelum sanitizer berbasis descriptor sempat menolaknya.
        // `origin` mentah diserahkan langsung.
        wakeClass, origin: deepFreeze(buildSafePayloadRef(origin)),
        state: "ARMED", firedAt: null, missedAt: null, retiredReason: null,
        occurrenceIndex: 0, armedAtMs: null, createdAt: nowIso
    });
}

function makeExpectation({ expectationId, subject, attribute, expectedValue, window, onSatisfied = "CLOSE", onViolated = "NOTIFY" }) {
    if (typeof expectationId !== "string" || !expectationId) fail(REASONS.INVALID_RECORD, "expectationId wajib string");
    // Bug review independen (audit putaran-32, AUD32-P2-2): `window.latestAt`/
    // `window.earliestAt` sebelumnya dibaca berkali-kali (typeof, Date.parse,
    // lalu lagi lewat `{...window}` saat konstruksi) -- getter stateful bisa
    // lolos validasi dengan tanggal sah lalu menyimpan nilai LAIN yang tidak
    // sah, membuat expectation PENDING selamanya (tidak pernah SATISFIED/
    // VIOLATED). Destructure SEKALI; validasi dan simpan pakai lokal yang sama.
    const { latestAt, earliestAt, ...windowRest } = window ?? {};
    if (typeof latestAt !== "string" || !Number.isFinite(Date.parse(latestAt))) {
        // PM-5: ekspektasi tanpa latestAt YANG SAH ditolak. Bug diketemukan
        // review independen (Codex, putaran ke-4): string tak-tanggal lolos
        // dulu, lalu Date.parse -> NaN membuat checkExpectations() tidak
        // pernah bisa melewati window (tidak pernah VIOLATED).
        fail(REASONS.NO_LATEST_AT, "window.latestAt wajib tanggal ISO yang sah (PM-5)");
    }
    if (earliestAt !== undefined && earliestAt !== null &&
        !Number.isFinite(Date.parse(earliestAt))) {
        fail(REASONS.NO_LATEST_AT, "window.earliestAt, jika ada, wajib tanggal ISO yang sah");
    }
    // Bug review independen (audit putaran-12, AUD12-P2-3): attribute/
    // onSatisfied/onViolated diteruskan mentah tanpa disaring -- BigInt di
    // salah satunya meledakkan JSON.stringify saat persist().
    if (typeof attribute !== "string" || !attribute) fail(REASONS.INVALID_RECORD, "attribute wajib string");
    if (typeof onSatisfied !== "string") fail(REASONS.INVALID_RECORD, "onSatisfied wajib string");
    if (typeof onViolated !== "string") fail(REASONS.INVALID_RECORD, "onViolated wajib string");
    // Bug review independen (audit putaran-33, AUD33-ADV-2): sibling
    // makeObservation (worldmodel)/makeHypothesis/validateConditionSpec
    // (goals) sudah mewajibkan subject berbentuk { entityId }|{ relationId }
    // -- makeExpectation tidak pernah dijaga sama, jadi subject:null lolos
    // lalu disalin sebagai `{}` (buildSafePayloadRef tidak menolak objek
    // kosong), mengirim subject yang tidak pernah valid ke evaluatePort().
    // Bug review independen (audit putaran-34, AUD34-P2-3): guard putaran-33
    // di atas membaca `subject.entityId`/`.relationId` langsung, lalu
    // konstruksi di bawah membacanya LAGI lewat `{...subject}` -- getter
    // stateful bisa lolos validasi dengan entityId sah lalu menyimpan
    // subject kosong (kelas yang sama dengan AUD34-P2-1/AUD34-P2-2).
    // Dikeluarkan sekali lewat destructuring.
    // Bug review independen (audit putaran-38, AUD38-P2-1): destructuring
    // di atas membaca `entityId`/`relationId` KEDUANYA lewat [[Get]] biasa
    // milik pemanggil SEBELUM buildSafePayloadRef sempat memprosesnya --
    // getter relationId tereksekusi bahkan ketika entityId sudah valid.
    // Disaring SEKALI lewat buildSafePayloadRef lebih dulu.
    const safeSubject = buildSafePayloadRef(subject);
    const validEntity = typeof safeSubject?.entityId === "string";
    if (!subject || (!validEntity && typeof safeSubject?.relationId !== "string")) {
        fail(REASONS.INVALID_RECORD, "subject wajib { entityId } atau { relationId }");
    }
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
        expectationId, subject: deepFreeze(safeSubject), attribute,
        expectedValue: deepFreeze(buildSafePayloadRef(expectedValue)),
        window: deepFreeze(buildSafePayloadRef({ ...windowRest, latestAt, earliestAt })),
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
    makeReminder, makeExpectation, makeWakeEvent, buildSafePayloadRef
};
