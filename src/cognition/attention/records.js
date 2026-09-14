"use strict";

/** W7-L5 ATTENTION — pembangun record murni (spec §3). */

const { REASONS, fail, AttentionError } = require("./errors");
const { clamp01 } = require("../core/envelope");

const SOURCE_KINDS = new Set(["OWNER", "SENSOR", "GOAL", "REMINDER", "MISSION", "AGENT", "SELF", "SYSTEM"]);
const WORK_KINDS = new Set(["PERCEIVE", "REASON", "PLAN", "VERIFY", "EXPLAIN", "MAINTAIN"]);
// Bug review independen (audit putaran-58, OpenCode, W7R58-P2-2): deepFreeze
// di sini adalah SATU-SATUNYA dari ke-6 sanitizer lane yang tidak pernah
// menolak kunci berbahaya -- envelope/goals/metacog/prospective/worldmodel
// semua menolak `__proto__`/`constructor`/`prototype`. `out[key] = ...`
// dengan key literal "__proto__" memanggil setter Object.prototype.__proto__
// pada copy, membuat hasil sanitisasi punya NOL own key tapi prototype
// yang dikendalikan pemanggil -- targetKey() membaca lewat prototype itu
// dan mengalias target arbitrer.
const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * Bug review independen (audit putaran-9, AUD9-P2-1): `Object.freeze({...
 * subjectRef})` cuma satu level -- objek bersarang di dalam subjectRef
 * tetap referensi milik pemanggil, mutasi pasca-panggilan menulis ulang
 * signal/target tersimpan lewat jalur yang lebih dalam.
 * Bug review independen (audit putaran-34, AUD34-ADV-4): deepFreeze
 * membekukan tapi tidak pernah menolak BigInt/angka non-finite, tidak
 * seperti sanitizer lane lain (buildSafeBeliefValue/buildSafePayloadRef/
 * buildSafeCognitiveCopy). Attention tidak punya persist(), jadi tidak
 * ada crash JSON hari ini -- tapi ini kesenjangan paritas sanitizer yang
 * sama persis dengan yang ditutup putaran-33 untuk prospective/metacog.
 * CATATAN: fungsi/Symbol SENGAJA TIDAK ditolak di sini (beda dengan lane
 * berpersist) -- AT-repair-5/18 menguji kontrak yang disengaja: hostile
 * toString/toJSON pada subjectRef/evidenceRef tetap diterima sebagai data
 * TIDAK AKTIF (tidak pernah dipanggil), bukan ditolak; membaca lewat
 * getOwnPropertyDescriptor (bukan `value[key]`) menutup jalur eksekusi
 * accessor pemanggil (kelas AUD10-P2-3/AUD24-P2-3) tanpa mengubah
 * kontrak fungsi-sebagai-data itu.
 */
function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh membawa BigInt");
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak boleh berupa angka non-finite (NaN/Infinity)");
    }
    if (t !== "object" && t !== "function") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (t === "function") return value; // fungsi diterima sebagai data tidak aktif, lihat catatan di atas
    // Bug review independen (audit putaran-41, AUD41-P2-3): sebuah Proxy
    // yang sudah di-revoke melempar TypeError MENTAH pada operasi dasar
    // apa pun terhadapnya (`Array.isArray`, `Reflect.ownKeys`,
    // `getOwnPropertyDescriptor`) -- round-40's AT-repair-36 hanya
    // menjamin kontrak "tidak raw-throw" untuk evidenceRef berbentuk
    // FUNCTION (Proxy.revocable(function(){})); Proxy.revocable({}) yang
    // di-revoke (typeof "object") tetap meledakkan TypeError mentah di
    // sini, keluar dari ingestSignal publik. Operasi dasar dibungkus
    // try/catch; kegagalan APA PUN pada level ini diperlakukan sebagai
    // penolakan tertutup (bukan crash), sama seperti setiap penolakan lain.
    try {
        const out = Array.isArray(value) ? [] : {};
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key === "string" && DANGEROUS_KEYS.includes(key)) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
            }
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) {
                fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `tidak boleh membawa properti accessor: '${String(key)}'`);
            }
            out[key] = deepFreeze(desc.value, seen);
        }
        return Object.freeze(out);
    } catch (err) {
        // Bug review independen (audit putaran-44, W7R44-P2-1): `err
        // instanceof AttentionError` memanggil [[GetPrototypeOf]] pada
        // `err` -- sebuah Proxy yang sengaja dilempar dengan trap
        // `getPrototypeOf` yang melempar membuat guard fail-closed ini
        // SENDIRI jadi permukaan raw-throw. Dibungkus try/catch; kegagalan
        // pemeriksaan ini dianggap BUKAN AttentionError.
        let isDomainError = false;
        try {
            isDomainError = err instanceof AttentionError;
        } catch {
            isDomainError = false;
        }
        if (isDomainError) throw err;
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "tidak dapat diverifikasi dengan aman, ditolak");
    }
}

function makeSignal({ signalId, sourceKind, sourceId, subjectRef, proposedUrgency = 0, evidenceRef = null, createdAtMs, expiresAtMs = null }) {
    if (typeof signalId !== "string" || !signalId) fail(REASONS.INVALID_RECORD, "signalId wajib string");
    // Bug review independen (audit putaran-25, AUD25-P2-1): interpolasi
    // `${sourceKind}` mentah meledakkan TypeError untuk Symbol.
    if (!SOURCE_KINDS.has(sourceKind)) fail(REASONS.INVALID_RECORD, `sourceKind '${typeof sourceKind === "string" ? sourceKind : typeof sourceKind}' tidak dikenal`);
    if (typeof sourceId !== "string" || !sourceId) fail(REASONS.INVALID_RECORD, "sourceId wajib string");
    // Bug review independen (audit putaran-28, AUD28-P2-2): `Number(proposedUrgency)`
    // meledakkan TypeError mentah untuk Symbol dan mengeksekusi valueOf
    // hostile untuk objek, SEBELUM clamp01 sempat menormalkannya.
    if (typeof proposedUrgency !== "number" && typeof proposedUrgency !== "string" && typeof proposedUrgency !== "boolean") {
        fail(REASONS.INVALID_RECORD, "proposedUrgency wajib angka");
    }
    // Bug review independen (audit putaran-32, AUD32-ADV-2): sibling dari
    // sweep angka non-finite di lane lain (envelope/goals/prospective/
    // worldmodel/selfmodel) yang belum menjangkau attention -- expiresAtMs
    // non-finite lolos mentah, tersimpan begitu saja di signal/target.
    if (expiresAtMs !== null && (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs))) {
        fail(REASONS.INVALID_RECORD, "expiresAtMs, jika ada, wajib angka finite");
    }
    // Bug review independen (audit putaran-38, AUD38-ADV-2): evidenceRef
    // primitif hanya dijaga untuk objek (deepFreeze) -- BigInt lolos
    // mentah, dan evidenceRefIdentity meruntuhkan SEMUA BigInt/Symbol/
    // function ke satu identitas ("bigint"/"symbol"/"function"), membuat
    // dua evidenceRef primitif yang benar-benar berbeda dihitung sebagai
    // korroborasi yang SAMA (undercounting). Ditolak tertutup, konsisten
    // dengan sweep angka non-finite di lane lain.
    if (typeof evidenceRef === "bigint") {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "evidenceRef tidak boleh berupa BigInt");
    }

    return Object.freeze({
        signalId, sourceKind, sourceId,
        // Bug review independen (audit putaran-37, AUD37-P2-3): `deepFreeze({
        // ...subjectRef })` men-spread subjectRef SEBELUM menyerahkannya ke
        // deepFreeze -- spread itu SENDIRI membaca setiap properti enumerable
        // (memanggil getter apa pun), lalu menyerahkan objek POLOS (tanpa
        // accessor lagi) ke deepFreeze yang berbasis descriptor. Sanitizer
        // berbasis descriptor jadi tidak pernah sungguh melihat accessor
        // aslinya -- kontrak "accessor tidak pernah tersentuh" gagal tepat
        // di titik pemanggilannya sendiri. deepFreeze diberi subjectRef
        // MENTAH langsung; ia sendiri yang membangun salinan aman.
        subjectRef: deepFreeze(subjectRef),
        proposedUrgency: clamp01(Number(proposedUrgency)), // AT-1: saran saja, bukan class final
        // Bug review independen (audit putaran-24, AUD24-P2-3): evidenceRef
        // OBJEK dulu disimpan APA ADANYA, tidak seperti subjectRef --
        // pemanggil bisa memutasinya pasca-panggilan (menulis ulang bukti
        // korroborasi tersimpan). Primitif (string/number) sudah immutable
        // dengan sendirinya, tidak perlu (dan tidak boleh, `{...'x'}`
        // merusak bentuknya) disalin ke objek.
        evidenceRef: (evidenceRef !== null && typeof evidenceRef === "object")
            ? deepFreeze(evidenceRef) : evidenceRef,
        createdAtMs, expiresAtMs
    });
}

function makeTarget({ targetId, subjectRef, workKind, priorityClass, admittedAtMs }) {
    if (typeof targetId !== "string" || !targetId) fail(REASONS.INVALID_RECORD, "targetId wajib string");
    // Bug review independen (audit putaran-26, AUD26-P2-1): sibling
    // ingestSignal's workKind message ditutup putaran-25, ini (makeTarget's
    // SENDIRI) terlewat.
    if (!WORK_KINDS.has(workKind)) fail(REASONS.INVALID_RECORD, `workKind '${typeof workKind === "string" ? workKind : typeof workKind}' tidak dikenal`);

    return Object.freeze({
        targetId, subjectRef: deepFreeze(subjectRef), workKind, priorityClass,
        effectivePriority: 0, admittedAt: admittedAtMs, startedAt: null, completedAt: null,
        state: "QUEUED", preemptions: 0,
        supportingSignalIds: Object.freeze([]), lastComputedAtMs: admittedAtMs
    });
}

module.exports = { SOURCE_KINDS, WORK_KINDS, makeSignal, makeTarget };
