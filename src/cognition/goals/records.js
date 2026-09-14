"use strict";

/** W7-L3 GOALS — pembangun record murni (spec §3, §5, §6). */

const { REASONS, fail, GoalError } = require("./errors");

const GOAL_KINDS = new Set(["OWNER_ASSIGNED", "SELF_PROPOSED", "MISSION_DERIVED", "MAINTENANCE"]);
const ORIGIN_KINDS = new Set(["OWNER", "SELF", "MISSION", "AGENT_SUGGESTION"]);
const PRIORITY_CLASSES = new Set(["CRITICAL", "HIGH", "NORMAL", "LOW", "BACKGROUND"]);

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * independen putaran-1, AUD-P2-4): makeTask menyebar intentTemplate tanpa
 * pagar kunci terlarang -- authProof/grant/balance bisa masuk lalu
 * persisten lewat restart, melemahkan klaim struktural GOAL != AUTHORITY
 * (pola yang sama sudah dipagari di prospective/longhorizon).
 */
const FORBIDDEN_INTENT_KEYS = Object.freeze([
    "authProof", "authorityDecision", "grant", "capabilityGrant",
    "executionLease", "balance", "allow", "owner", "executor",
    "route", "trustedNode", "rootAuthority"
]);
const DANGEROUS_INTENT_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

// Bug review independen (audit putaran-40, AUD40-P2-3; sibling dari
// AUD39-P2-2 di metacog/AUD40-P2-2 di worldmodel): `arr.map(cb)` MELEWATI
// lubang (hole) pada array jarang (sparse) -- `cb` tidak pernah dipanggil
// untuk indeks kosong, jadi guard elemen di dalam callback tidak pernah
// tereksekusi untuk lubang itu. Loop indeks eksplisit mengunjungi SETIAP
// indeks (termasuk lubang, sebagai `undefined`) tanpa mengonsultasikan
// `Symbol.iterator` -- beda dengan `Array.from`, yang melempar TypeError
// mentah kalau `Symbol.iterator` ADA tapi bukan function (AUD40-ADV-1).
// Bug review independen (audit putaran-41, AUD41-P2-2, regresi
// diperkenalkan kandidat putaran-40): loop di atas dulu membaca
// `arr.length` di KONDISI loop -- dievaluasi ULANG setiap iterasi. Proxy
// dengan getter `length` yang TERUS BERTAMBAH (dan getter indeks yang
// memalsukan nilai) membuat loop TIDAK PERNAH berhenti (diukur >5 juta
// iterasi) -- `.map()` yang digantikan HANYA membaca `length` SEKALI di
// awal. `length` sekarang di-cache SEKALI ke lokal sebelum loop dimulai.
// Bug review independen (audit putaran-42, W7R42-P2-2/W7R42-ADV-1): `len`
// di-cache tapi tidak pernah divalidasi -- Proxy dengan getter `length`
// yang mengembalikan `Infinity` membuat loop TIDAK PERNAH berhenti (DoS)
// sekalipun sudah tidak dibaca ulang; `NaN`/negatif diam-diam menghasilkan
// array kosong (bukan penolakan); pecahan (non-integer) menghasilkan
// jumlah elemen yang tidak konsisten dengan `Array.prototype.map`'s
// `ToLength`. `length` sekarang divalidasi sebagai integer terhingga
// non-negatif dan dibatasi eksplisit sebelum loop dimulai.
const MAX_SAFE_ARRAY_LENGTH = 65536;
// Bug review independen (audit putaran-43, W7R43-P2-8/W7R43-ADV-1): `steps`
// dulu dibatasi MAX_STEPS_PER_PLAN lewat pembacaan `.length` KEDUA yang
// terpisah di goals/index.js (SEBELUM panggilan ini) -- Proxy dengan getter
// `length` yang berbohong pada baca kedua lolos cek kuota lalu menyimpan
// jauh lebih banyak elemen dari yang diizinkan (MEMALSUKAN penegakan
// MAX_STEPS_PER_PLAN, bukan cuma raw-throw). `maxLen`/`overLimitReason`
// sekarang opsional supaya PEMANGGIL bisa menegakkan batas KHUSUS FIELD-nya
// memakai `len` yang SAMA PERSIS dipakai loop di bawah -- satu-satunya
// pembacaan `.length`, tidak ada celah divergensi yang mungkin.
function buildSafeArray(arr, mapFn, maxLen = MAX_SAFE_ARRAY_LENGTH, overLimitReason = REASONS.INVALID_RECORD, overLimitMessage = "panjang array melebihi batas") {
    const len = arr.length;
    if (!Number.isInteger(len) || len < 0) {
        fail(REASONS.INVALID_RECORD, "panjang array tidak sah");
    }
    if (len > maxLen) {
        fail(overLimitReason, overLimitMessage);
    }
    const out = [];
    for (let i = 0; i < len; i++) out.push(mapFn(arr[i], i));
    return out;
}

const INTENT_ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_INTENT_SCAN_DEPTH = 16;
const MAX_INTENT_ARRAY_LENGTH = 1024;
const MAX_INTENT_KEYS = 256;
const MAX_INTENT_NODES = 512;

/**
 * Bug review independen (OpenCode/9router deepseek-v4.1-flash, audit
 * putaran-3, AUD3-P1-1/AUD3-P1-2): satu lintasan yang MEMVALIDASI dan
 * MEMBANGUN salinan aman sekaligus -- sama seperti perbaikan di
 * prospective/records.js dan core/envelope.js. Versi lama (putaran-2)
 * memvalidasi lewat pemeriksaan descriptor lalu membekukan OBJEK ASLI
 * pemanggil (`deepFreeze(intentTemplate)`); sebuah Proxy dengan trap
 * `get`/`getPrototypeOf`/`ownKeys` konsisten-tapi-bohong tetap bisa
 * memalsukan nilai saat dibaca ulang, dan node perantara yang sudah beku
 * atau properti non-enumerable bisa melindungi anak yang masih bisa
 * diubah dari `deepFreeze`. Sekarang nilai HANYA pernah dibaca dari
 * `desc.value` (hasil `getOwnPropertyDescriptor`, sudah final -- trap
 * `get` proxy tidak pernah dipanggil) dan disalin ke objek/array polos
 * baru yang kita bangun sendiri, lalu dibekukan; objek asli pemanggil
 * tidak pernah disimpan atau dibaca lagi setelah validasi.
 */
function buildSafeIntentTemplate(value, depth = 0, budget) {
    // Bug review independen (audit putaran-14, AUD14-P1-1): walker ini tidak
    // punya anggaran jumlah node seperti worldmodel's buildSafeBeliefValue
    // (W7R5-P1-2) -- sebuah DAG referensi-bersama (BUKAN siklus, jadi lolos
    // MAX_INTENT_SCAN_DEPTH) dengan fanout kecil meledak eksponensial
    // (fan^depth salinan), CPU/memory DoS trivial lewat proposeGoal/
    // createTask/createPlan. `budget` diwariskan rekursif sepanjang SATU
    // panggilan (dibuat baru hanya di titik masuk).
    if (!budget) budget = { count: 0 };
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa fungsi (termasuk toJSON)");
    if (t === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa Symbol");
    // Bug review independen (audit putaran-9, AUD9-P2-3): BigInt lolos lewat
    // `t !== "object"` -> return value apa adanya (sama seperti asimetri di
    // buildSafeBeliefValue), lalu meledakkan `JSON.stringify` di
    // saveSnapshot() saat persist() -- satu record bisa mematikan seluruh
    // durabilitas lane goals/prospective.
    if (t === "bigint") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa BigInt (tidak dapat diserialisasi)");
    // Bug review independen (audit putaran-31, AUD31-ADV-1): sibling dari
    // worldmodel's buildSafeBeliefValue (AUD30-ADV-1) -- angka non-finite
    // (Infinity/-Infinity/NaN) lolos apa adanya lalu diam-diam berubah
    // jadi `null` saat persist() lewat backend JSON.
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh berupa angka non-finite (NaN/Infinity)");
    }
    if (t !== "object") return value;
    if (depth > MAX_INTENT_SCAN_DEPTH) {
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate terlalu dalam untuk diverifikasi dengan aman, ditolak");
    }
    budget.count += 1;
    if (budget.count > MAX_INTENT_NODES) {
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "jumlah node pada intentTemplate melebihi batas");
    }

    // Bug review independen (audit putaran-43, W7R43-P2-7): `Array.isArray`/
    // `Object.getPrototypeOf`/`Reflect.ownKeys` di bawah adalah operasi
    // dasar terhadap `value` yang belum tepercaya -- sebuah Proxy yang
    // di-revoke (di KEDALAMAN MANAPUN dalam intentTemplate, bukan cuma
    // level teratas) melempar TypeError MENTAH pada operasi ini, keluar
    // dari API publik (proposeGoal/createPlan/createTask/dst). Seluruh
    // logika pembentukan cabang array/objek dibungkus try/catch; error
    // GoalError (termasuk yang dilempar ulang dari rekursi anak) diteruskan
    // apa adanya, kegagalan APA PUN lainnya gagal tertutup.
    try {
        if (Array.isArray(value)) {
            // Bug review independen (audit putaran-4, W7R4-P2-4): walker ini
            // tidak punya batas panjang array seperti saudaranya di
            // prospective (MAX_PAYLOAD_ARRAY_LENGTH) dan envelope
            // (GLOBAL_MAX_ARRAY_LENGTH) -- array-like Proxy dengan `length`
            // besar bisa memaksa loop tak terbatas.
            // Bug review independen (audit putaran-42, W7R42-P2-1): `value.length`
            // dulu dibaca SEKALI untuk cek batas ini, lalu dibaca ULANG di
            // KONDISI loop di bawah setiap iterasi -- Proxy dengan getter
            // `length` yang terus bertambah (dipasangkan getter indeks yang
            // memalsukan nilai) membuat `i` dan `length` naik bersamaan, loop
            // TIDAK PERNAH berhenti (DoS). `length` di-cache SEKALI ke lokal
            // dan divalidasi sebagai integer terhingga non-negatif SEBELUM
            // dipakai di mana pun.
            const len = value.length;
            if (!Number.isInteger(len) || len < 0 || len > MAX_INTENT_ARRAY_LENGTH) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "panjang array pada intentTemplate melebihi batas atau tidak sah");
            }
            const arrProto = Object.getPrototypeOf(value);
            if (arrProto !== Array.prototype && arrProto !== null) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa array dengan prototype non-standar");
            }
            const out = [];
            for (let i = 0; i < len; i++) {
                const desc = Object.getOwnPropertyDescriptor(value, i);
                if (!desc || desc.get || desc.set) {
                    fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${i}'`);
                }
                const built = buildSafeIntentTemplate(desc.value, depth + 1, budget);
                out[i] = built === undefined ? null : built;
            }
            for (const key of Reflect.ownKeys(value)) {
                if (key === "length" || INTENT_ARRAY_INDEX_PATTERN.test(String(key))) continue;
                if (typeof key === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa kunci Symbol");
                if (DANGEROUS_INTENT_KEYS.includes(key)) fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `kunci berbahaya ditolak: '${key}'`);
                if (FORBIDDEN_INTENT_KEYS.includes(key)) {
                    fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa '${key}' (di kedalaman manapun)`);
                }
                const desc = Object.getOwnPropertyDescriptor(value, key);
                if (!desc || desc.get || desc.set) {
                    fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${String(key)}'`);
                }
                buildSafeIntentTemplate(desc.value, depth + 1, budget); // divalidasi, tidak disalin (properti non-indeks array)
            }
            return out;
        }

        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh berupa instance kelas (kontrak data murni)");
        }
        const objKeys = Reflect.ownKeys(value);
        if (objKeys.length > MAX_INTENT_KEYS) {
            fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "jumlah kunci pada intentTemplate melebihi batas");
        }
        const out = {};
        for (const key of objKeys) {
            if (typeof key === "symbol") fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak boleh membawa kunci Symbol");
            if (DANGEROUS_INTENT_KEYS.includes(key)) fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `kunci berbahaya ditolak: '${key}'`);
            if (FORBIDDEN_INTENT_KEYS.includes(key)) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa '${key}' (di kedalaman manapun)`);
            }
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, `intentTemplate tidak boleh membawa properti accessor: '${String(key)}'`);
            }
            const built = buildSafeIntentTemplate(desc.value, depth + 1, budget);
            if (built !== undefined) out[key] = built;
        }
        return out;
    } catch (err) {
        if (err instanceof GoalError) throw err;
        fail(REASONS.AUTHORITY_SHAPED_FIELD_REJECTED, "intentTemplate tidak dapat diverifikasi dengan aman, ditolak");
    }
}

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

function validateConditionSpec(spec, label) {
    if (!spec || typeof spec !== "object") fail(REASONS.INVALID_RECORD, `${label} wajib objek`);
    // Bug review independen (audit putaran-24, AUD24-P2-4): `typeof
    // spec.subject !== "object"` TIDAK menolak `null` (typeof null ===
    // "object"), jadi subject:null lolos lalu spread ke `{}` -- tersimpan
    // tanpa entityId/relationId nyata, kolaps lewat subjectKeyOf ke kunci
    // sentinel bersama yang menggabungkan kondisi tak-terkait. Sibling
    // makeObservation/makeHypothesis sudah pakai guard bentuk positif ini.
    // Bug review independen (audit putaran-30, AUD30-P2-2): `spec.subject`
    // dulu dibaca BERKALI-KALI (tiga kali di guard ini, sekali lagi saat
    // membangun salinan aman di bawah) -- accessor stateful bisa
    // mengembalikan subject sah pada baca-baca guard lalu subject cacat
    // (mis. {}) pada baca terakhir, meloloskan kondisi yang tidak bisa
    // dievaluasi. Dibaca SEKALI ke lokal, dipakai untuk validasi MAUPUN
    // salinan aman.
    // `subject` DIKELUARKAN dari `spec` lewat destructuring (bukan
    // `spec.subject` terpisah lalu `{...spec}` di bawah) -- spread objek
    // membaca ULANG setiap properti enumerable milik sumbernya termasuk
    // `subject`, jadi `{...spec, subject: {...subject}}` tanpa destructuring
    // tetap memanggil getter subject DUA KALI (sekali oleh `{...spec}`,
    // override-nya diabaikan). Dengan destructuring, `specRest` TIDAK
    // PERNAH punya kunci `subject` sama sekali, jadi spread-nya tidak
    // menyentuhnya lagi -- total tepat SATU baca.
    // Bug review independen (audit putaran-31, AUD31-P2-3): perbaikan
    // putaran-30 hanya mengeluarkan `subject` lewat destructuring --
    // `kind`/`attribute` masih divalidasi lewat `spec.kind`/`spec.attribute`
    // (baca KEDUA), sementara nilai TERSIMPAN datang dari `specRest` (yang
    // sudah membaca kind/attribute SEKALI lewat pengumpulan rest destructuring
    // di atas) -- getter stateful bisa membuat guard memvalidasi baca
    // KEDUA yang valid sementara nilai tersimpan (baca PERTAMA) tidak
    // valid. `kind`/`attribute` sekarang ikut dikeluarkan lewat
    // destructuring yang SAMA, divalidasi sebagai lokal, dan lokal itulah
    // yang dipakai membangun salinan aman di bawah.
    const { subject, kind, attribute, ...specRest } = spec;
    // Bug review independen (audit putaran-34, AUD34-P2-1; putaran-38,
    // AUD38-P2-1): destructuring putaran-31 mengeluarkan `subject` ITU
    // SENDIRI dari `spec` untuk satu baca, tapi properti DALAM subject
    // (`entityId`/`relationId`) masih dibaca lewat [[Get]] biasa milik
    // pemanggil SEBELUM buildSafeIntentTemplate (yang menolak accessor
    // lewat descriptor) sempat memprosesnya -- getter relationId
    // pemanggil tereksekusi bahkan ketika entityId sudah valid (beda
    // dengan makeHypothesis/ingestDeclaration di worldmodel yang sudah
    // disaring lebih dulu). Disaring SEKALI di sini; entityId/relationId
    // diturunkan dari salinan aman itu dengan short-circuit.
    const safeSubject = buildSafeIntentTemplate(subject);
    const validEntity = typeof safeSubject?.entityId === "string";
    if (typeof kind !== "string" ||
        !subject || (!validEntity && typeof safeSubject?.relationId !== "string") ||
        typeof attribute !== "string") {
        fail(REASONS.UNVERIFIABLE_SUCCESS_CONDITION,
            `${label} tidak dapat dievaluasi (kind/subject/attribute wajib ada)`);
    }
    // Bug review independen (audit putaran-8, W7R8-P2-1): `Object.freeze({...spec})`
    // dangkal -- `spec.subject` tetap referensi milik pemanggil, jadi
    // mutasi pasca-proposeGoal/createTask menulis ulang subject kondisi
    // yang sudah tersimpan.
    // Bug review independen (audit putaran-9, AUD9-P2-1): round-8's fix
    // hanya membekukan SATU level `spec.subject` -- objek bersarang di
    // dalamnya (mis. spec.subject.nested) tetap referensi milik pemanggil,
    // mutasi pasca-panggilan menulis ulang kondisi tersimpan lewat jalur
    // yang lebih dalam. deepFreeze menutup ini di semua kedalaman.
    // Bug review independen (audit putaran-9, AUD9-P2-3): `expectedValue`
    // tidak pernah disaring -- BigInt di dalamnya lolos lalu meledakkan
    // JSON.stringify di saveSnapshot() saat persist(). buildSafeIntentTemplate
    // menyaring BigInt/function/Symbol dan membekukan salinannya sekaligus.
    // Bug review independen (audit putaran-10, AUD10-P1-1): round-9 menyaring
    // expectedValue lewat buildSafeIntentTemplate tapi LUPA membekukan hasilnya
    // (beda dengan makeTask's intentTemplate yang sudah benar --
    // `deepFreeze(safeIntentTemplate)`) -- salinan plain object yang
    // dikembalikan buildSafeIntentTemplate tetap bisa dimutasi pemanggil
    // pasca-panggilan, menulis ulang semantik evaluasi kondisi tersimpan.
    // Bug review independen (audit putaran-11, AUD11-P2-2): perbaikan putaran-10
    // hanya menyaring/membekukan `subject`/`expectedValue` -- field lain yang
    // ikut ter-spread (`...spec`, mis. field ekstra bebas pemanggil) tidak
    // pernah disaring ATAU dibekukan sama sekali. Seluruh spec sekarang
    // disaring+dibekukan sekaligus lewat buildSafeIntentTemplate (yang sudah
    // menolak BigInt/function/Symbol di kedalaman berapa pun); subject tetap
    // ditangani terpisah karena wajib objek (bukan dilewatkan begitu saja).
    return deepFreeze(buildSafeIntentTemplate({ ...specRest, kind, attribute, subject: safeSubject }));
}

/** G-1/G-2: SELF_PROPOSED tidak pernah menyetujui dirinya; AGENT_SUGGESTION tidak pernah mengatur ownerApproval. */
function makeGoal({
    goalId, title, kind, origin, priorityClass = "NORMAL",
    successCondition, abandonCondition = null, deadline = null,
    parentGoalId = null, depth = 0, budgetRef = null, missionRef = null, nowIso
}) {
    if (typeof goalId !== "string" || !goalId) fail(REASONS.INVALID_RECORD, "goalId wajib string");
    // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
    // `${kind}` mentah di pesan error meledakkan TypeError SEBELUM fail()
    // sempat dilempar kalau kind berupa Symbol (atau mengeksekusi toString
    // pemanggil kalau berupa objek) -- diganti representasi aman (typeof
    // untuk non-string, nilai asli untuk string).
    if (!GOAL_KINDS.has(kind)) fail(REASONS.INVALID_RECORD, `kind '${typeof kind === "string" ? kind : typeof kind}' tidak dikenal`);
    // Bug review independen (audit putaran-28, AUD28-P2-7): `String(title)`
    // mentah mengeksekusi toString hostile milik pemanggil (dan meledakkan
    // TypeError mentah untuk Symbol) sebelum sempat disimpan.
    if (typeof title !== "string" || !title) fail(REASONS.INVALID_RECORD, "title wajib string");
    // Bug review independen (audit putaran-39, AUD39-ADV-1): guard ini dan
    // keputusan ownerApproval di bawah membaca `origin.kind` lewat [[Get]]
    // biasa milik pemanggil SEBELUM buildSafeIntentTemplate (descriptor-
    // based) sempat menyaringnya -- kelas yang sama tepat dengan
    // AUD34-P2-1..AUD38-P2-1 (subject) yang belum menjangkau `origin` di
    // builder ini. Disaring SEKALI lebih dulu; `originKind` diturunkan
    // dari salinan aman itu.
    const safeOrigin = buildSafeIntentTemplate(origin);
    const originKind = safeOrigin?.kind;
    if (!origin || !ORIGIN_KINDS.has(originKind)) fail(REASONS.INVALID_RECORD, "origin.kind tidak dikenal");
    if (!PRIORITY_CLASSES.has(priorityClass)) fail(REASONS.INVALID_RECORD, "priorityClass tidak dikenal");

    const condition = validateConditionSpec(successCondition, "successCondition");

    let ownerApproval;
    if (kind === "SELF_PROPOSED" || originKind === "AGENT_SUGGESTION") {
        // G-1/G-2: self-proposal atau saran agen TIDAK PERNAH menyetel approval sendiri.
        ownerApproval = Object.freeze({ state: "REQUIRED", approvalRef: null, grantedAt: null, scope: null });
    } else {
        ownerApproval = Object.freeze({ state: "NOT_REQUIRED", approvalRef: null, grantedAt: null, scope: null });
    }

    // Bug review independen (audit putaran-10, AUD10-P2-1): `deadline`/
    // `budgetRef`/`missionRef`/`origin` dulu disimpan mentah tanpa disaring --
    // BigInt di dalamnya lolos lalu meledakkan JSON.stringify di
    // saveSnapshot() saat persist(). buildSafeIntentTemplate menyaring
    // BigInt/function/Symbol (dan menolak kunci authority-shaped di origin).
    return Object.freeze({
        goalId, title: title.slice(0, 500), kind,
        // Bug review independen (audit putaran-37, AUD37-P2-3; putaran-39,
        // AUD39-ADV-1): `origin` disaring SEKALI di atas (safeOrigin);
        // salinan yang SAMA dipakai di sini, tidak disaring dua kali.
        origin: deepFreeze(safeOrigin),
        ownerApproval,
        state: "PROPOSED",
        priorityClass,
        successCondition: condition,
        abandonCondition: abandonCondition ? validateConditionSpec(abandonCondition, "abandonCondition") : null,
        // Bug review independen (audit putaran-13, AUD13-P1-1): round-10
        // menyaring BigInt lewat buildSafeIntentTemplate tapi LUPA
        // membekukan hasilnya (beda dengan `origin` dua baris di atas yang
        // sudah benar -- `deepFreeze(buildSafeIntentTemplate(...))`) --
        // salinan plain object tetap bisa dimutasi pemanggil pasca-panggilan
        // (menulis ulang deadline/budgetRef/missionRef kanonik), dan sebuah
        // toJSON yang disisipkan pemanggil pada objek yang dikembalikan
        // tereksekusi saat persist() lalu memalsukan kunci authority-shaped
        // (mis. authProof) ke dalam snapshot durabel -- melanggar GOAL !=
        // AUTHORITY.
        deadline: deepFreeze(buildSafeIntentTemplate(deadline)), parentGoalId, depth,
        budgetRef: deepFreeze(buildSafeIntentTemplate(budgetRef)), missionRef: deepFreeze(buildSafeIntentTemplate(missionRef)),
        createdAt: nowIso, lastTransitionAt: nowIso,
        transitions: Object.freeze([])
    });
}

function makeCommitment({ commitmentId, goalRef, toWhom, promise, dueCondition, missedPolicy = "NOTIFY" }) {
    if (typeof commitmentId !== "string" || !commitmentId) fail(REASONS.INVALID_RECORD, "commitmentId wajib string");
    if (typeof goalRef !== "string" || !goalRef) fail(REASONS.INVALID_RECORD, "goalRef wajib string");
    // Bug review independen (audit putaran-28, AUD28-P2-7): `String(promise)`
    // mentah mengeksekusi toString hostile milik pemanggil.
    if (typeof promise !== "string" || !promise) fail(REASONS.INVALID_RECORD, "promise wajib string");
    return Object.freeze({
        commitmentId, goalRef,
        // Bug review independen (audit putaran-37, AUD37-P2-3): `{...toWhom}`
        // men-spread SEBELUM diserahkan ke buildSafeIntentTemplate -- spread
        // itu sendiri membaca setiap properti enumerable (memanggil getter
        // apa pun) sebelum sanitizer berbasis descriptor sempat melihatnya.
        // `toWhom` mentah diserahkan langsung; sanitizer sendiri yang
        // membangun salinan aman.
        toWhom: deepFreeze(buildSafeIntentTemplate(toWhom)),
        promise: promise.slice(0, 500),
        dueCondition: validateConditionSpec(dueCondition, "dueCondition"),
        state: "OPEN", evidenceRef: null,
        missedPolicy: ["NOTIFY", "ESCALATE", "SILENT_RECORD"].includes(missedPolicy) ? missedPolicy : "NOTIFY"
    });
}

function makePlan({ planId, goalRef, version = 1, steps, assumptions = [], createdBy = "SELF", maxSteps = MAX_SAFE_ARRAY_LENGTH }) {
    if (typeof planId !== "string" || !planId) fail(REASONS.INVALID_RECORD, "planId wajib string");
    // Bug review independen (audit putaran-42, W7R42-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada `Array.isArray`
    // -- dibungkus try/catch supaya kegagalan APA PUN gagal tertutup.
    let isStepsArray;
    try {
        isStepsArray = Array.isArray(steps);
    } catch {
        fail(REASONS.INVALID_RECORD, "steps tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isStepsArray) fail(REASONS.INVALID_RECORD, "steps wajib array taskId");
    // Bug review independen (audit putaran-12, AUD12-P2-2): sapuan BigInt
    // putaran-10/11 hanya menyentuh field yang ditandai auditor -- createdBy
    // tetap diteruskan mentah; BigInt di dalamnya meledakkan JSON.stringify
    // saat persist().
    if (typeof createdBy !== "string" || !createdBy) fail(REASONS.INVALID_RECORD, "createdBy wajib string");
    // Bug review independen (audit putaran-13, AUD13-P2-2): sapuan putaran-12
    // hanya menyaring createdBy -- goalRef/version/steps[] masih diteruskan
    // mentah; BigInt di salah satunya meledakkan JSON.stringify saat
    // persist(), dan version non-number merusak perbandingan
    // `a.version - b.version` pada kompaksi.
    if (typeof goalRef !== "string" || !goalRef) fail(REASONS.INVALID_RECORD, "goalRef wajib string");
    if (!Number.isFinite(version)) fail(REASONS.INVALID_RECORD, "version wajib number");
    // Bug review independen (audit putaran-20, AUD20-P2-2): `assumptions`
    // (beda dengan `steps`) tidak pernah dijaga Array.isArray -- `null`
    // eksplisit lolos default parameter (hanya `undefined` yang memicunya)
    // lalu meledakkan `.map()` jadi TypeError mentah, bukan INVALID_RECORD.
    // Bug review independen (audit putaran-43, W7R43-P2-4): sibling
    // langsung dari `steps` dua baris di atas (round-42 hanya menutup
    // `steps`) -- Proxy yang di-revoke melempar TypeError mentah pada
    // `Array.isArray(assumptions)` juga.
    let isAssumptionsArray;
    try {
        isAssumptionsArray = Array.isArray(assumptions);
    } catch {
        fail(REASONS.INVALID_RECORD, "assumptions tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isAssumptionsArray) fail(REASONS.INVALID_RECORD, "assumptions wajib array");
    // Bug review independen (audit putaran-10, AUD10-P2-2; diperdalam
    // putaran-13, AUD13-P2-2): sapuan deepFreeze putaran-9 hanya membekukan
    // steps/assumptions, tidak pernah menyaringnya -- BigInt di dalam salah
    // satu elemen meledakkan JSON.stringify saat persist(). buildSafeIntentTemplate
    // menyaring BigInt/function/Symbol di elemen apa pun (string taskId
    // ATAU objek langkah terstruktur, keduanya dipakai penelepon nyata di
    // basis kode ini), lalu deepFreeze membekukan hasilnya.
    return Object.freeze({
        planId, goalRef, version,
        steps: deepFreeze(buildSafeArray(steps, s => buildSafeIntentTemplate(s), maxSteps, REASONS.PLAN_STEP_LIMIT_EXCEEDED, "jumlah langkah rencana melebihi batas")),
        createdBy, assumptions: deepFreeze(buildSafeArray(assumptions, a => buildSafeIntentTemplate(a))),
        invalidatedBy: Object.freeze([]), state: "DRAFT"
    });
}

function makeTask({ taskId, planRef, order, capabilityId = null, preconditions = [], postconditions = [], intentTemplate, maxAttempts = 5 }) {
    if (typeof taskId !== "string" || !taskId) fail(REASONS.INVALID_RECORD, "taskId wajib string");
    // Bug review independen (audit putaran-12, AUD12-P2-2): planRef/order/
    // capabilityId diteruskan mentah tanpa disaring -- BigInt di salah
    // satunya meledakkan JSON.stringify saat persist().
    if (typeof planRef !== "string" || !planRef) fail(REASONS.INVALID_RECORD, "planRef wajib string");
    if (!Number.isFinite(order)) fail(REASONS.INVALID_RECORD, "order wajib number");
    if (capabilityId !== null && (typeof capabilityId !== "string" || !capabilityId)) {
        fail(REASONS.INVALID_RECORD, "capabilityId, jika ada, wajib string");
    }
    // Bug review independen (audit putaran-20, AUD20-P2-2): preconditions/
    // postconditions tidak pernah dijaga Array.isArray -- `null` eksplisit
    // lolos default parameter lalu meledakkan `.map()` jadi TypeError mentah.
    // Bug review independen (audit putaran-43, W7R43-P2-4): Proxy yang
    // di-revoke melempar TypeError mentah pada `Array.isArray` di sini juga.
    let isPreArray, isPostArray;
    try {
        isPreArray = Array.isArray(preconditions);
    } catch {
        fail(REASONS.INVALID_RECORD, "preconditions tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isPreArray) fail(REASONS.INVALID_RECORD, "preconditions wajib array");
    try {
        isPostArray = Array.isArray(postconditions);
    } catch {
        fail(REASONS.INVALID_RECORD, "postconditions tidak dapat diverifikasi dengan aman, ditolak");
    }
    if (!isPostArray) fail(REASONS.INVALID_RECORD, "postconditions wajib array");
    const safeIntentTemplate = buildSafeIntentTemplate(intentTemplate ?? {});
    return Object.freeze({
        taskId, planRef, order, capabilityId,
        preconditions: Object.freeze(buildSafeArray(preconditions, c => validateConditionSpec(c, "precondition"))),
        postconditions: Object.freeze(buildSafeArray(postconditions, c => validateConditionSpec(c, "postcondition"))),
        intentTemplate: deepFreeze(safeIntentTemplate),
        state: "PENDING", attempts: 0, maxAttempts, lastOutcomeRef: null
    });
}

module.exports = {
    GOAL_KINDS, ORIGIN_KINDS, PRIORITY_CLASSES,
    validateConditionSpec, makeGoal, makeCommitment, makePlan, makeTask
};
