"use strict";

const fs = require("node:fs");
const path = require("node:path");
const utilTypes = require("node:util").types;

/**
 * Primitive DIBEKUKAN SAAT MODUL DIMUAT, lalu dipanggil lewat `Reflect.apply`
 * yang juga dibekukan.
 *
 * Merek durabel (di bawah) menegaskan "sink ini menulis DAN fsync", jadi jalur
 * tulis TIDAK boleh dapat dibelokkan oleh kode penelepon.
 *
 * Kenapa `Reflect.apply` dan BUKAN `FN.call(...)`: `FILE_FSYNC_SYNC` menunjuk
 * ke objek fungsi yang SAMA dengan `fs.fsyncSync`, dan objek itu masih dapat
 * dijangkau penelepon. `FN.call(...)` adalah pencarian properti `call` pada
 * objek itu -- cukup dengan menempelkan `call` no-op sebagai properti sendiri di
 * `fs.fsyncSync`, flush asli hilang sementara merek durabel tetap terpasang
 * (audit 2712bf3). Memanggil fungsi yang sudah dibekukan SECARA LANGSUNG tidak
 * melakukan pencarian properti apa pun.
 *
 * POLA YANG SAMA BERLAKU UNTUK SEMUA INTRINSIK yang dipakai jalur kepercayaan:
 * `WeakSet.prototype.add/has` dan `util.types.isProxy` juga diambil SEKALI di
 * sini dan dipanggil lewat `Reflect.apply`. Sebelumnya ketiganya dipanggil
 * sebagai `WEAKSET.has(x)` / `utilTypes.isProxy(x)` -- pencarian properti pada
 * objek yang masih dapat dijangkau, sehingga penimpaan pasca-pemuatan cukup
 * untuk memalsukan merek durabel atau menjalankan trap Proxy yang seharusnya
 * ditolak (audit 0132c36).
 *
 * BATAS YANG DISEBUT JUJUR: kode yang sudah berjalan di proses ini SEBELUM modul
 * dimuat dapat mengganti apa pun, termasuk intrinsik di bawah, sehingga yang
 * TERBEKUKAN adalah implementasi palsu. Itu threat model yang sama dengan
 * seluruh merek leksikal lane ini (dan CommonJS cache), dan tidak diklaim
 * tertutup di sini.
 */
const REFLECT_APPLY = Reflect.apply;
const FILE_OPEN_SYNC = fs.openSync;
const FILE_WRITE_SYNC = fs.writeSync;
const FILE_FSYNC_SYNC = fs.fsyncSync;
const FILE_CLOSE_SYNC = fs.closeSync;
const IS_PROXY_INTRINSIC = utilTypes.isProxy;
const WEAKSET_HAS = WeakSet.prototype.has;
const WEAKSET_ADD = WeakSet.prototype.add;
const GET_OWN_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;

/** `util.types.isProxy` lewat intrinsic yang dibekukan (tanpa pencarian properti). */
function isProxyIntrinsic(value) {
    return REFLECT_APPLY(IS_PROXY_INTRINSIC, utilTypes, [value]);
}

/** `WeakSet.prototype.has` lewat intrinsic yang dibekukan. */
function weakSetHas(set, value) {
    return REFLECT_APPLY(WEAKSET_HAS, set, [value]);
}

/** `WeakSet.prototype.add` lewat intrinsic yang dibekukan. */
function weakSetAdd(set, value) {
    REFLECT_APPLY(WEAKSET_ADD, set, [value]);
}

/**
 * Apakah nilai ini Proxy.
 *
 * Diperiksa LEBIH DULU di `resolveFsyncOption`: setiap operasi reflektif pada
 * Proxy menjalankan trap milik pemanggil, jadi tidak ada pembacaan opsi yang
 * aman -- `Object.getOwnPropertyDescriptor` dan `Object.getPrototypeOf` pun
 * mengeksekusi trap (audit 2712bf3).
 */
function isProxyValue(value) {
    if (value === null || typeof value !== "object") return false;
    try {
        return isProxyIntrinsic(value);
    } catch {
        return true;   // tidak dapat dipastikan -> perlakukan sebagai tidak aman
    }
}

/**
 * Baca `options.fsync` lewat DESKRIPTOR.
 *
 * `options.fsync !== false` adalah `[[Get]]` mentah: getter di objek opsi
 * menjalankan kode penelepon, yang dapat mengganti `fs.fsyncSync` sebelum sink
 * menulis apa pun (audit c894e05). Pembacaan lewat deskriptor tidak menjalankan
 * accessor; nilai accessor diperlakukan sebagai "tidak menyatakan apa pun",
 * sehingga default aman (fsync aktif) tetap berlaku.
 */
function resolveFsyncOption(options) {
    if (options === null || typeof options !== "object") return true;
    if (isProxyValue(options)) return true;      // trap apa pun tidak boleh jalan
    let desc;
    try {
        desc = REFLECT_APPLY(GET_OWN_DESCRIPTOR, Object, [options, "fsync"]);
    } catch {
        return true;
    }
    if (!desc) {
        // Mungkin diwarisi; telusuri prototipe lewat deskriptor juga.
        let proto;
        try {
            proto = REFLECT_APPLY(GET_PROTOTYPE_OF, Object, [options]);
        } catch {
            return true;
        }
        if (proto === null) return true;
        return resolveFsyncOption(proto);
    }
    if (desc.get || desc.set) return true;
    return desc.value !== false;
}


const { LedgerError, CODES } = require("./errors");
const { digestCore } = require("./events");
const { sha256Hex, isValidDigestFormat } = require("./integrity");
const { canonicalJson } = require("./canonicalJson");

/**
 * DURABLE AUDIT LEDGER FILE SINK — append-only JSONL production adapter
 * (Trust Foundation stage, Wave 5 Lane 4).
 *
 * This implements the EXISTING AuditPersistencePort contract
 * (ports.js) for the canonical Audit Ledger — it does NOT replace the
 * ledger and does NOT implement a second log.  It is the narrow durable
 * sink the existing ledger persistence precondition requires.
 *
 * LAW:
 *   - AUDIT LEDGER != AUTHORITY.  This sink persists immutable
 *     observational records only; it grants nothing.
 *
 * DURABILITY MODEL (synchronous, matching the V1 atomic contract):
 *   - append(record) serializes the FROZEN record to ONE canonical JSON
 *     line and fsync-flushes it to the sink file.  The write happens
 *     BEFORE the ledger's in-memory commit, so a failed write rejects the
 *     append atomically (the event is never falsely "durably committed").
 *   - Appends are serialized through an in-process write queue so
 *     overlapping appends cannot interleave or corrupt the line stream.
 *   - Each line is independently self-describing and hash-chained via the
 *     record's own integrity block (sequence + prevDigest + digest).
 *
 * RESTART / CONTINUATION:
 *   - On construction the sink reads the existing file and verifies the
 *     chain (per-record digest + prev-linkage + strictly increasing
 *     sequence).  It exposes describeDurable() returning the observed
 *     tail state ({ records, lastSequence, lastDigest }) so a caller can
 *     continue a ledger across restart.
 *   - A corrupt, truncated, or chain-broken file FAILS CLOSED: the sink
 *     enters an explicit `corrupt` state and REFUSES all further appends
 *     (never silently appending onto a broken chain).  It never silently
 *     resets history.
 *
 * REDACTION / HYGIENE:
 *   - The record is already redacted by the ledger before it reaches the
 *     sink; this sink writes the record verbatim and never logs values.
 *   - No Vault secret/proof/token values are written here (the sink only
 *     ever sees redacted audit events).
 *   - File is created 0o600; writes use atomic line-append with fsync.
 */

const SINK_KIND = "audit-file-jsonl-v1";

/**
 * Merek leksikal untuk sink DURABEL yang benar-benar dimiliki lane ini.
 *
 * Port `AuditPersistencePort` mendokumentasikan "return true on success; throw
 * to reject", tapi bentuk itu dipenuhi oleh sink APA PUN -- termasuk
 * `{ append() {} }` yang tidak menulis apa-apa. Karena sebuah klaim "tercatat
 * durabel" (FG-03) hanya boleh dibuat bila ada sink yang benar-benar menulis ke
 * disk dan fsync, sink yang dibuat di sini didaftarkan pada WeakSet modul dan
 * pemeriksaannya tidak dapat dipalsukan dari luar (audit 7677a0f).
 */
const DURABLE_AUDIT_SINKS = new WeakSet();

/** Apakah `candidate` adalah sink durabel yang dibuat oleh factory di modul ini. */
function isDurableAuditSink(candidate) {
    return candidate !== null
        && (typeof candidate === "object" || typeof candidate === "function")
        && weakSetHas(DURABLE_AUDIT_SINKS, candidate);
}

function failPersist(message, detail) {
    return new LedgerError(CODES.PERSIST_FAILED, message, detail);
}

function failSink(message) {
    return new LedgerError(CODES.INVALID_EVENT, message);
}

/** Canonical one-line serialization of a frozen audit record. */
function serializeRecordLine(record) {
    // Reuse the ledger's own canonical serializer for byte-determinism.
    return canonicalJson(record, { maxDepth: 32 });
}

/** Parse + validate one stored line back into a record shell. */
function parseRecordLine(line) {
    let record;
    try {
        record = JSON.parse(line);
    } catch {
        throw failSink("stored audit line is not valid JSON");
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
        throw failSink("stored audit line is not an object");
    }
    return record;
}

/** Verify a stored record's self-digest matches its content. */
function verifySelfDigest(record) {
    if (!record.integrity || typeof record.integrity !== "object") {
        throw failSink("stored audit record missing integrity block");
    }
    if (!isValidDigestFormat(record.integrity.digest)) {
        throw failSink("stored audit record digest malformed");
    }
    const expected = sha256Hex(Buffer.from(digestCore(record), "utf8"));
    if (expected !== record.integrity.digest) {
        throw failSink("stored audit record digest mismatch");
    }
}

/**
 * Verify a run of stored records forms a valid chain: strictly increasing
 * sequence, each record's prevDigest equals the previous record's digest,
 * and every self-digest is valid.  Returns the tail state.
 */
function verifyChain(records) {
    let lastSequence = 0;
    let lastDigest = null;
    const seenIds = new Set();
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!Number.isSafeInteger(record.sequence) || record.sequence <= lastSequence) {
            throw failSink("stored audit sequence is not strictly increasing");
        }
        verifySelfDigest(record);
        if (i > 0 && record.integrity.prevDigest !== lastDigest) {
            throw failSink("stored audit chain link mismatch");
        }
        if (seenIds.has(record.eventId)) {
            throw failSink("stored audit duplicate eventId");
        }
        seenIds.add(record.eventId);
        lastSequence = record.sequence;
        lastDigest = record.integrity.digest;
    }
    return { lastSequence, lastDigest, count: records.length };
}

/**
 * createFileAuditSink(filePath, options)
 *
 * @param {string} filePath durable JSONL sink file.
 * @param {object} [options]
 * @param {boolean} [options.fsync=true] fsync after each append (durable).
 */
function createFileAuditSink(filePath, options = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
        throw failSink("audit file sink requires a file path");
    }
    const fsync = resolveFsyncOption(options);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    // TF-003 SINGLE-WRITER OWNERSHIP: an exclusive lock file guards the
    // canonical sink file so two active sink owners (in this process or
    // cooperating local processes) cannot own the same file and append
    // conflicting tail state.  The lock is acquired atomically
    // (create-exclusive) and is NOT a distributed lock service — it is the
    // narrow local ownership the existing single-process runtime expects.
    // Candidate-tail validation remains mandatory even with ownership.
    //
    // TF-007 STALE-LOCK RECOVERY: the lock records its owner pid.  A lock
    // whose owner process no longer exists (crashed writer) is reclaimed
    // through an ownership-validated atomic replace + re-verify — a LIVE
    // writer is never stolen (fail closed), and an unreadable lock fails
    // closed for manual inspection.  Age alone is never a reason to steal.
    const lockPath = `${filePath}.lock`;
    let lockHeld = false;

    function readLockFile() {
        try {
            const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (data === null || typeof data !== "object" ||
                data.v !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0) {
                return { present: true, valid: false };
            }
            return { present: true, valid: true, pid: data.pid };
        } catch (error) {
            if (error && error.code === "ENOENT") return { present: false };
            return { present: true, valid: false };
        }
    }

    function pidAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            // EPERM: the process exists but is owned by someone else —
            // treat as alive (conservative).
            return error && error.code === "EPERM";
        }
    }

    function writeLockContent(fd) {
        fs.writeFileSync(fd, JSON.stringify({
            v: 1, pid: process.pid, acquiredAtMs: Date.now()
        }), { encoding: "utf8" });
    }

    function failOwned() {
        return new LedgerError(CODES.PERSIST_FAILED,
            "audit sink file is already owned by another active writer");
    }

    try {
        // "wx" = O_CREAT|O_EXCL|O_WRONLY: fails if the lock already exists.
        const fd = fs.openSync(lockPath, "wx");
        try { writeLockContent(fd); } finally { fs.closeSync(fd); }
        lockHeld = true;
    } catch (error) {
        if (error && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES")) {
            const current = readLockFile();
            if (!current.present) {
                // Vanished between the failed open and the read: one clean
                // retry through the same create-exclusive path.
                try {
                    const fd = fs.openSync(lockPath, "wx");
                    try { writeLockContent(fd); } finally { fs.closeSync(fd); }
                    lockHeld = true;
                } catch (retryError) {
                    if (retryError && (retryError.code === "EEXIST" || retryError.code === "EPERM" || retryError.code === "EACCES")) {
                        throw failOwned();
                    }
                    throw failPersist(`audit sink lock acquisition failed: ${retryError.message}`);
                }
            } else if (!current.valid) {
                // Unreadable/corrupt lock: fail closed; operator inspects.
                throw new LedgerError(CODES.PERSIST_FAILED,
                    "audit sink lock file is unreadable; manual inspection required");
            } else if (pidAlive(current.pid)) {
                throw failOwned();
            } else {
                // STALE (dead writer): ownership-validated reclaim — unique
                // temp + atomic rename, then RE-VERIFY the lock now records
                // OUR pid (a competing reclaimer wins and we fail closed).
                const claim = JSON.stringify({
                    v: 1, pid: process.pid, acquiredAtMs: Date.now()
                });
                const tmp = `${lockPath}.claim-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
                fs.writeFileSync(tmp, claim, { encoding: "utf8", mode: 0o600 });
                try {
                    fs.renameSync(tmp, lockPath);
                } catch (renameError) {
                    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
                    throw failPersist(`audit sink lock reclaim failed: ${renameError.message}`);
                }
                const after = readLockFile();
                if (!after.valid || after.pid !== process.pid) {
                    throw failOwned();
                }
                lockHeld = true;
            }
        } else {
            throw failPersist(`audit sink lock acquisition failed: ${error.message}`);
        }
    }

    function releaseLock() {
        if (!lockHeld) return;
        lockHeld = false;
        // Ownership-checked unlink: never delete a foreign lock.
        const current = readLockFile();
        if (current.present && current.valid && current.pid === process.pid) {
            try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
        }
    }

    // ---- load + verify existing tail (restart continuation) ----------
    let tail = { lastSequence: 0, lastDigest: null, count: 0 };
    let corrupt = false;
    let corruptReason = null;
    const seenEventIds = new Set();

    if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const records = [];
        try {
            for (const line of lines) {
                records.push(parseRecordLine(line));
            }
            tail = verifyChain(records);
            for (const record of records) seenEventIds.add(record.eventId);
        } catch (error) {
            // FAIL CLOSED: corrupt/truncated/chain-broken history.  Enter an
            // explicit recovery state; refuse all further appends; never
            // silently append onto a broken chain and never silently reset.
            corrupt = true;
            corruptReason = error instanceof LedgerError ? error.message : "stored audit history failed verification";
        }
    }

    // In-process write queue: appends never interleave mid-line.
    let writing = false;
    const queue = [];

    function appendLine(line) {
        // Atomic append of one fsync'd line. O_EX so two sinks cannot both
        // create the file; the queue guarantees single-writer ordering here.
        //
        // Dipanggil lewat REFLECT_APPLY yang dibekukan saat modul dimuat, bukan
        // `FN.call(...)`: `call` adalah properti pada objek fungsi yang masih
        // dapat dijangkau penelepon, sehingga `fs.fsyncSync.call = () => {}`
        // cukup untuk menghapus flush asli sementara merek durabel tetap
        // terpasang (audit 2712bf3).
        const fd = REFLECT_APPLY(FILE_OPEN_SYNC, fs, [filePath, "a"]);
        try {
            REFLECT_APPLY(FILE_WRITE_SYNC, fs, [fd, line + "\n"]);
            if (fsync) REFLECT_APPLY(FILE_FSYNC_SYNC, fs, [fd]);
        } finally {
            REFLECT_APPLY(FILE_CLOSE_SYNC, fs, [fd]);
        }
    }

    function drain() {
        if (writing) return;
        writing = true;
        try {
            while (queue.length > 0) {
                const line = queue.shift();
                appendLine(line);
            }
        } finally {
            writing = false;
        }
    }

    const sink = {
        /**
         * Persist one frozen audit record.  Synchronous; throws
         * LedgerError(PERSIST_FAILED) on any failure so the ledger rejects
         * the append atomically (no false durable success).
         *
         * TF-001 CANDIDATE-TAIL VALIDATION: even with single-writer
         * ownership, every candidate is validated against the CURRENT
         * durable tail — sequence must be exactly tail+1 and prevDigest
         * must equal the durable last digest.  Skipped/duplicate sequence,
         * wrong prevDigest, and wrong self-digest are all rejected.
         */
        append(record) {
            if (corrupt) {
                throw failPersist(
                    `audit sink is in a corrupt recovery state and refuses appends: ${corruptReason}`);
            }
            if (record === null || typeof record !== "object" || Array.isArray(record)) {
                throw failPersist("audit record must be an object");
            }
            if (typeof record.eventId !== "string" || record.eventId.length === 0) {
                throw failPersist("audit record missing eventId");
            }
            if (seenEventIds.has(record.eventId)) {
                throw failPersist("duplicate eventId in durable audit sink");
            }
            // ---- candidate-tail validation (TF-001) --------------------
            if (!Number.isSafeInteger(record.sequence)) {
                throw failPersist("audit record sequence must be an integer");
            }
            if (record.sequence !== tail.lastSequence + 1) {
                throw failPersist(
                    `audit sequence must continue the durable tail exactly ` +
                    `(expected ${tail.lastSequence + 1}, got ${record.sequence})`);
            }
            const prevDigest = record.integrity && record.integrity.prevDigest !== undefined
                ? record.integrity.prevDigest
                : undefined;
            if (prevDigest !== tail.lastDigest) {
                throw failPersist("audit prevDigest does not match the durable tail digest");
            }
            // The record's own self-digest must be valid for its content.
            try {
                verifySelfDigest(record);
            } catch (error) {
                throw failPersist(`audit record failed integrity validation: ${error.message}`);
            }
            let line;
            try {
                line = serializeRecordLine(record);
            } catch (error) {
                throw failPersist(`audit record failed canonical serialization: ${error.message}`);
            }
            try {
                queue.push(line);
                drain();
            } catch (error) {
                throw failPersist(`audit sink write failed: ${error.message}`);
            }
            seenEventIds.add(record.eventId);
            tail = {
                lastSequence: record.sequence,
                lastDigest: record.integrity && typeof record.integrity.digest === "string"
                    ? record.integrity.digest
                    : tail.lastDigest,
                count: tail.count + 1
            };
            return true;
        },

        /** Observed durable tail state for restart continuation. */
        describeDurable() {
            return Object.freeze({
                kind: SINK_KIND,
                corrupt,
                corruptReason,
                records: tail.count,
                lastSequence: tail.lastSequence,
                lastDigest: tail.lastDigest,
                fsync
            });
        },

        /**
         * Verified resume seed for the canonical ledger (TF-001).  The sink
         * holds no sequence authority — it only reports verified durable
         * tail state; the canonical createAuditLedger resumes from it.
         */
        verifiedTail() {
            if (corrupt) {
                throw failPersist(
                    `cannot resume from a corrupt audit sink: ${corruptReason}`);
            }
            return Object.freeze({
                lastSequence: tail.lastSequence,
                lastDigest: tail.lastDigest
            });
        },

        /** Read back the verified stored records (bounded, for continuation/tests). */
        readAll() {
            if (!fs.existsSync(filePath)) return Object.freeze([]);
            const raw = fs.readFileSync(filePath, "utf8");
            const lines = raw.split("\n").filter((l) => l.trim().length > 0);
            return Object.freeze(lines.map((l) => parseRecordLine(l)));
        },

        /** Release the single-writer lock (TF-003).  Idempotent. */
        close() {
            releaseLock();
        }
    };

    const frozenSink = Object.freeze(sink);
    // HANYA sink yang benar-benar fsync yang di-brand DURABEL.
    //
    // Merek ini adalah dasar klaim "rekaman durabel" (FG-03), dan janji itu
    // menyebut fsync secara eksplisit: `createFileAuditSink(path, {fsync:false})`
    // menulis tanpa flush, sehingga sebuah deployment bisa memperoleh
    // konfirmasi governed tanpa durabilitas yang disyaratkan (audit 8fbfcdd).
    // Tanpa fsync, sink ini tetap dapat dipakai -- ia hanya tidak dihitung
    // sebagai bukti durabel.
    if (fsync) weakSetAdd(DURABLE_AUDIT_SINKS, frozenSink);
    return frozenSink;
}

module.exports = Object.freeze({
    createFileAuditSink,
    isDurableAuditSink,
    SINK_KIND
});
