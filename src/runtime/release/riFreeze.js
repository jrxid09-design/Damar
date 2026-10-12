"use strict";

/**
 * CANONICAL RI FREEZE V1 — satu-satunya otoritas status beku identitas rilis RI.
 *
 * FUNGSI (load-bearing):
 *   SATU freeze record, SATU store, SATU consumer.
 *   SHA dan tree selalu 40-hex penuh dan dibandingkan PERSIS.
 *   Pembaca MEMERIKSA record di disk setiap kali membaca; ia tidak pernah
 *     percaya bentuknya sendiri.
 *   Kandidat divalidasi SEBELUM ditulis; penulisan yang gagal tertutup.
 *   Freeze kedua dengan identitas berbeda DITOLAK, tidak pernah menimpa.
 *   Record yang rusak/terhapus parsial = INVALID, dan INVALID menutup
 *     fail-closed di SEMUA jalur (status maupun consumer).
 *
 * YANG BUKAN OTORITAS (dinyatakan eksplisit):
 *   Git tag, environment variable, isi process memory, file JSON bebas di
 *   luar store ini, dan output model/tool TIDAK pernah memenuhi consumer.
 *   Modul ini juga tidak pernah menurunkan SHA/tree dari working tree yang
 *   bisa berubah — identitas SELALU diberikan pemanggil dan divalidasi
 *   bentuknya; korealisasi tag <-> commit adalah OPERASI yang dilakukan
 *   pemanggil, di luar proses ini.
 *
 * KEADAAN LAIN YANG DITOLAK SECARA DISENGAJA:
 *   Tidak ada signing, tidak ada chaining, tidak ada klaim kriptografis
 *   terhadap mutasi disk yang disengaja. Yang dijamin adalah: tidak ada
 *   mutasi yang TIDAK terlihat (gagal tertutup, tidak pernah menimpa),
 *   dan setiap pembaca melihat record yang sama persis.
 *
 * BENTUKAN AUTHORITY: `store` hanyalah bentuk yang sudah dimiliki ACC kanonik
 * (`getKv`/`putKv`); modul ini tidakvolutional mendefinisikan interface baru.
 */

const RI_FREEZE_SCHEMA_VERSION = "ri-freeze/1";
const RI_FREEZE_MECHANISM = "damar.runtime.release.riFreeze";
const RI_FREEZE_KEY = "release:ri-freeze";

const FREEZE_STATUS = Object.freeze({
    NOT_FROZEN: "NOT_FROZEN",
    FROZEN: "FROZEN",
    INVALID: "INVALID"
});

const FREEZE_CODES = Object.freeze({
    OK_APPLIED: "OK_APPLIED",
    OK_IDEMPOTENT: "OK_IDEMPOTENT",
    REJECTED_CANDIDATE_INVALID: "REJECTED_CANDIDATE_INVALID",
    REJECTED_IDENTITY_CONFLICT: "REJECTED_IDENTITY_CONFLICT",
    REJECTED_EXISTING_INVALID: "REJECTED_EXISTING_INVALID",
    REJECTED_STORE_UNUSABLE: "REJECTED_STORE_UNUSABLE",
    REJECTED_NOT_FROZEN: "REJECTED_NOT_FROZEN",
    REJECTED_RECORD_INVALID: "REJECTED_RECORD_INVALID",
    REJECTED_RELEASE_INVALID: "REJECTED_RELEASE_INVALID",
    REJECTED_RELEASE_MISMATCH: "REJECTED_RELEASE_MISMATCH"
});

// Git object id: 40 lowercase hex. Shorthand, uppercase, or any other
// shape is refused so that one identity can never have two spellings.
const OID = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Validasi kandidat identitas SEBELUM tulis. Mengembalikan record beku
 * berisi HANYA field yang dikenal — key asing tidak pernah diteruskan ke
 * store, sehingga record yang tersimpan tidak bisa membawa payload bebas.
 */
function validateCandidate(candidate) {
    if (!isPlainObject(candidate)) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "not-an-object" };
    }
    if (candidate.schemaVersion !== RI_FREEZE_SCHEMA_VERSION) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "schema-version" };
    }
    if (candidate.mechanism !== RI_FREEZE_MECHANISM) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "mechanism" };
    }
    if (typeof candidate.sha !== "string" || !OID.test(candidate.sha)) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "sha" };
    }
    if (typeof candidate.tree !== "string" || !OID.test(candidate.tree)) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "tree" };
    }
    if (!Number.isSafeInteger(candidate.createdAtMs) || candidate.createdAtMs < 0) {
        return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "created-at" };
    }
    // Digest bukti bersifat opsional dan HANYA diterima kalau memang
    // diberikan DAN berbentuk sha256 hex penuh. Tidak ada jalur yang
    // mengarang atau mengarang ulang digest yang tidak diberikan pemanggil.
    let evidenceDigest = null;
    if (candidate.evidenceDigest !== undefined && candidate.evidenceDigest !== null) {
        if (typeof candidate.evidenceDigest !== "string" || !SHA256_HEX.test(candidate.evidenceDigest)) {
            return { ok: false, code: FREEZE_CODES.REJECTED_CANDIDATE_INVALID, reason: "evidence-digest" };
        }
        evidenceDigest = candidate.evidenceDigest;
    }
    return {
        ok: true,
        record: Object.freeze({
            schemaVersion: RI_FREEZE_SCHEMA_VERSION,
            mechanism: RI_FREEZE_MECHANISM,
            sha: candidate.sha,
            tree: candidate.tree,
            createdAtMs: candidate.createdAtMs,
            evidenceDigest
        })
    };
}

/**
 * Validasi record yang dibaca KEMBALI dari store. Sengaja terpisah dari
 * validateCandidate: pembaca tidak boleh mempercayai bentuk yang ia
 * temukan, dan record parsial harus berakhir sebagai INVALID, bukan
 * "diperbaiki diam-diam".
 */
function validateStoredRecord(raw) {
    if (!isPlainObject(raw)) return { ok: false, reason: "not-an-object" };
    if (raw.schemaVersion !== RI_FREEZE_SCHEMA_VERSION) return { ok: false, reason: "schema-version" };
    if (raw.mechanism !== RI_FREEZE_MECHANISM) return { ok: false, reason: "mechanism" };
    if (typeof raw.sha !== "string" || !OID.test(raw.sha)) return { ok: false, reason: "sha" };
    if (typeof raw.tree !== "string" || !OID.test(raw.tree)) return { ok: false, reason: "tree" };
    if (!Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs < 0) return { ok: false, reason: "created-at" };
    if (raw.evidenceDigest !== null && raw.evidenceDigest !== undefined) {
        if (typeof raw.evidenceDigest !== "string" || !SHA256_HEX.test(raw.evidenceDigest)) {
            return { ok: false, reason: "evidence-digest" };
        }
    }
    return { ok: true };
}

function unusableStore(store) {
    return !store
        || typeof store.getKv !== "function"
        || typeof store.putKv !== "function";
}

/**
 * STATUS — baca durable, validasi, kategorikan.
 *   NOT_FROZEN : belum ada record sama sekali.
 *   FROZEN     : record utuh dan lolos validasi.
 *   INVALID    : ada record tapi rusak/versi salah/tidak lengkap.
 * Tidak pernah menebak: bentuk buruk bukan "belum frozen".
 */
async function readFreeze(store) {
    if (unusableStore(store)) {
        return { status: FREEZE_STATUS.INVALID, record: null, code: FREEZE_CODES.REJECTED_STORE_UNUSABLE };
    }
    let raw;
    try {
        raw = await store.getKv(RI_FREEZE_KEY);
    } catch (error) {
        return {
            status: FREEZE_STATUS.INVALID,
            record: null,
            code: FREEZE_CODES.REJECTED_STORE_UNUSABLE,
            reason: `read-failed:${error?.code ?? "unknown"}`
        };
    }
    if (raw === null || raw === undefined) {
        return { status: FREEZE_STATUS.NOT_FROZEN, record: null, code: null };
    }
    const verdict = validateStoredRecord(raw);
    if (!verdict.ok) {
        // Record ada tapi tidak bisa dipercaya: fail closed, dan jangan
        // bocorkan bagian yang tidak tervalidasi ke luar.
        return { status: FREEZE_STATUS.INVALID, record: null, code: FREEZE_CODES.REJECTED_RECORD_INVALID, reason: verdict.reason };
    }
    return {
        status: FREEZE_STATUS.FROZEN,
        record: Object.freeze({
            schemaVersion: raw.schemaVersion,
            mechanism: raw.mechanism,
            sha: raw.sha,
            tree: raw.tree,
            createdAtMs: raw.createdAtMs,
            evidenceDigest: raw.evidenceDigest ?? null
        }),
        code: null
    };
}

/**
 * Terapkan freeze. Kontrak idempotensi yang eksplisit:
 *   - kandidat tidak valid            -> DITOLAK, tidak ada tulisan
 *   - belum ada record                -> ditulis sekali            (OK_APPLIED)
 *   - record ada, identitas SAMA      -> TIDAK ditulis ulang        (OK_IDEMPOTENT)
 *   - record ada, identitas BEDA      -> DITOLAK                   (REJECTED_IDENTITY_CONFLICT)
 *   - record ada tapi INVALID         -> DITOLAK, tidak menimpa    (REJECTED_EXISTING_INVALID)
 * Perbandingan identitas persis pada `sha` DAN `tree`; createdAtMs dan
 * evidenceDigest bukan bagian dari identitas, jadi tidak memengaruhi
 * keputusan konflik maupun idempotensi.
 */
/**
 * Read-modify-write, given a (getKv, putKv) pair.
 *
 * Factored out so the SAME decision code runs either inside the store's
 * atomic `transact` span or, for a store without one, directly. What decides
 * is `io` — never this function — so the two paths cannot drift.
 */
async function commitAgainst(io, validated) {
    const existing = await readFreeze(io);
    if (existing.status === FREEZE_STATUS.INVALID) {
        return {
            ok: false,
            applied: false,
            code: FREEZE_CODES.REJECTED_EXISTING_INVALID,
            reason: existing.reason ?? existing.code,
            status: FREEZE_STATUS.INVALID
        };
    }
    if (existing.status === FREEZE_STATUS.FROZEN) {
        const same = existing.record.sha === validated.record.sha
            && existing.record.tree === validated.record.tree;
        if (!same) {
            return {
                ok: false,
                applied: false,
                code: FREEZE_CODES.REJECTED_IDENTITY_CONFLICT,
                frozen: existing.record,
                status: FREEZE_STATUS.FROZEN
            };
        }
        return {
            ok: true,
            applied: false,
            code: FREEZE_CODES.OK_IDEMPOTENT,
            record: existing.record,
            status: FREEZE_STATUS.FROZEN
        };
    }
    try {
        await io.putKv(RI_FREEZE_KEY, validated.record);
    } catch (error) {
        return {
            ok: false,
            applied: false,
            code: FREEZE_CODES.REJECTED_STORE_UNUSABLE,
            reason: `write-failed:${error?.code ?? "unknown"}`,
            status: FREEZE_STATUS.NOT_FROZEN
        };
    }
    // Read back: what is authoritative is what is actually on disk, not what
    // we just handed it.
    const readback = await readFreeze(io);
    if (readback.status !== FREEZE_STATUS.FROZEN) {
        return {
            ok: false,
            applied: false,
            code: FREEZE_CODES.REJECTED_STORE_UNUSABLE,
            reason: `readback-${readback.status}`,
            status: readback.status
        };
    }
    return {
        ok: true,
        applied: true,
        code: FREEZE_CODES.OK_APPLIED,
        record: readback.record,
        status: FREEZE_STATUS.FROZEN
    };
}

async function applyFreeze({ store, candidate } = {}) {
    if (unusableStore(store)) {
        return { ok: false, applied: false, code: FREEZE_CODES.REJECTED_STORE_UNUSABLE, status: FREEZE_STATUS.INVALID };
    }
    const validated = validateCandidate(candidate);
    if (!validated.ok) {
        return {
            ok: false,
            applied: false,
            code: validated.code,
            reason: validated.reason,
            status: FREEZE_STATUS.NOT_FROZEN
        };
    }
    // The ACC store's `transact` makes the read-decide-write sequence
    // atomic, so two concurrent applies of DIFFERENT identities can never
    // both observe "no record" and race each other into a silent overwrite.
    // ponytail: single-writer stores (the in-memory backend) keep the plain
    // path; drop this branch only if `transact` is removed from the store
    // contract, never because it is awkward to call.
    if (typeof store.transact === "function") {
        return await store.transact((tx) => commitAgainst(tx, validated));
    }
    return await commitAgainst(store, validated);
}

/**
 * CONSUMER KANONIK. Satu-satunya penentu apakah sebuah identitas rilis RI
 * boleh proceed. Sumber kebenarannya adalah PEMBACAAN DURABLE dari store —
 * bukan argumen, bukan cache, bukan marker lain.
 *
 * `release` adalah identitas yang DIKLAIM pemanggil. Modul ini tidak pernah
 * mengarangnya dan tidak pernah menurunkannya dari working tree.
 */
async function assertReleaseFrozen({ store, release } = {}) {
    const state = await readFreeze(store);
    if (state.status === FREEZE_STATUS.NOT_FROZEN) {
        return { ok: false, code: FREEZE_CODES.REJECTED_NOT_FROZEN, status: state.status, frozen: null };
    }
    if (state.status === FREEZE_STATUS.INVALID) {
        return {
            ok: false,
            code: FREEZE_CODES.REJECTED_RECORD_INVALID,
            reason: state.reason ?? state.code,
            status: state.status,
            frozen: null
        };
    }
    if (!isPlainObject(release)
        || typeof release.sha !== "string" || !OID.test(release.sha)
        || typeof release.tree !== "string" || !OID.test(release.tree)) {
        return { ok: false, code: FREEZE_CODES.REJECTED_RELEASE_INVALID, status: state.status, frozen: state.record };
    }
    if (release.sha !== state.record.sha || release.tree !== state.record.tree) {
        return {
            ok: false,
            code: FREEZE_CODES.REJECTED_RELEASE_MISMATCH,
            status: state.status,
            frozen: state.record,
            release: Object.freeze({ sha: release.sha, tree: release.tree })
        };
    }
    return { ok: true, code: "OK_FROZEN_MATCH", status: state.status, frozen: state.record };
}

module.exports = Object.freeze({
    RI_FREEZE_SCHEMA_VERSION,
    RI_FREEZE_MECHANISM,
    RI_FREEZE_KEY,
    FREEZE_STATUS,
    FREEZE_CODES,
    validateCandidate,
    validateStoredRecord,
    readFreeze,
    applyFreeze,
    assertReleaseFrozen
});