const sqlite3 = require("sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * Pembungkus Promise di atas node-sqlite3 yang berbasis callback.
 *
 * Seluruh lapisan memori memakai satu koneksi. SQLite menulis
 * secara serial, jadi menambah koneksi tidak menambah throughput
 * tulis — yang ada malah menaikkan risiko SQLITE_BUSY.
 *
 * KEPEMILIKAN TRANSAKSI (R4): keanggotaan transaksi hanya lewat capability
 * `TransactionScope` yang diberikan ke callback `exclusive` / `transaction`.
 * Konteks async (AsyncLocalStorage) TIDAK memberi kepemilikan.
 *
 * SIKLUS HIDUP TRANSAKSI (R5): Database memiliki BEGIN/COMMIT/ROLLBACK.
 *   - capability menolak pernyataan kontrol transaksi (BEGIN, COMMIT, END,
 *     ROLLBACK, SAVEPOINT, RELEASE) dari kode pemanggil;
 *   - saat span keluar, koneksi WAJIB tanpa transaksi. Sisa transaksi di-rollback
 *     (tidak pernah di-commit diam-diam) dan dilaporkan sebagai error. Keadaan
 *     koneksi diperiksa dengan ROLLBACK: "no transaction is active" berarti bersih.
 *     node-sqlite3 tidak mengekspos status autocommit, jadi ini sumber kebenaran
 *     yang paling andal yang tersedia;
 *   - bila ROLLBACK tidak bisa dipastikan, koneksi di-poison dan operasi
 *     berikutnya ditolak sampai instance dibuka ulang;
 *   - span yang menunggu kerja di luar dirinya dibatasi `spanDeadlineMs`,
 *     sehingga antrean tidak terkunci selamanya.
 */

const DEFAULT_SPAN_DEADLINE_MS = 30_000;
const BEGIN_ATTEMPTS = 8;

const CODES = Object.freeze({
    UNSCOPED: "UNSCOPED_DB_CALL_DURING_ACTIVE_TRANSACTION",
    EXPIRED: "TX_CAPABILITY_EXPIRED",
    REENTRANT: "DB_SPAN_REENTRANT",
    FOREIGN: "FOREIGN_DB_TX_CAPABILITY",
    DEADLINE: "DB_SPAN_DEADLINE_EXCEEDED",
    DANGLING: "DB_TX_DANGLING_AT_SPAN_EXIT",
    POISONED: "DB_CONNECTION_POISONED",
    TX_CONTROL: "TX_CONTROL_NOT_ALLOWED",
    BEGIN_BUSY: "TX_BEGIN_BUSY"
});

const FINISH = Symbol("finish");
const BEGIN = Symbol("begin");

const SPAN_CONTEXT = new AsyncLocalStorage();

const noop = () => {};

function dbError(code, message, cause) {
    return Object.assign(new Error(`${code}: ${message}`, cause === undefined ? undefined : { cause }), { code });
}

/** Pernyataan kontrol transaksi pada SQL teks (dipisah per `;`, komentar dibuang). */
function isTransactionControl(sql) {

    const text = String(sql ?? "")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ");

    return text.split(";").some(part => /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(part));

}

/**
 * Span satu transaksi. Operasinya berurutan (FIFO). Setelah `retire` span
 * tidak pernah bisa dipakai lagi, termasuk oleh `unseal`.
 */
class Span {

    #gate;
    #open = true;
    #retired = false;
    #chain = Promise.resolve();

    constructor(gate) {
        this.#gate = gate;
    }

    isLive() {
        return this.#open;
    }

    seal() {
        this.#open = false;
    }

    /** Hanya bila COMMIT gagal dan transaksi masih terbuka untuk ROLLBACK. */
    unseal() {
        if (!this.#retired) {
            this.#open = true;
        }
    }

    retire() {
        this.#retired = true;
        this.#open = false;
    }

    /** Antrekan operasi penyimpanan di belakang operasi span sebelumnya. */
    enqueue(work, { closing = false } = {}) {

        const ctx = SPAN_CONTEXT.getStore();

        // Capability span lain yang masih hidup pada konteks ini: tolak.
        if (ctx && ctx.span !== this && ctx.span.isLive()) {
            return Promise.reject(dbError(CODES.FOREIGN, "transaction capability belongs to another open span"));
        }

        if (!closing && !this.#open) {
            return Promise.reject(dbError(CODES.EXPIRED, "transaction capability is no longer usable"));
        }

        const run = this.#chain.then(async () => work(await this.#gate.ensure()));

        this.#chain = run.then(noop, noop);

        return run;

    }

    /** Tunggu operasi penyimpanan yang sudah diantre. Tidak menunggu kerja pengguna. */
    drain() {
        return this.#chain;
    }

}

/**
 * Capability transaksi yang diberikan ke callback. Opaque: tidak bisa
 * diserialisasi dan mati setelah span selesai.
 */
class TransactionScope {

    #span;

    constructor(span) {
        this.#span = span;
    }

    run(sql, params = []) {
        return this.#statement(sql, db => runOn(db, sql, params));
    }

    get(sql, params = []) {
        return this.#statement(sql, db => getOn(db, sql, params));
    }

    all(sql, params = []) {
        return this.#statement(sql, db => allOn(db, sql, params));
    }

    exec(sql) {
        return this.#statement(sql, db => execOn(db, sql));
    }

    toJSON() {
        throw dbError(CODES.EXPIRED, "transaction capability is not serializable");
    }

    #statement(sql, work) {

        if (isTransactionControl(sql)) {
            return Promise.reject(dbError(
                CODES.TX_CONTROL,
                "BEGIN/COMMIT/ROLLBACK/SAVEPOINT are owned by Database.transaction, not the capability"
            ));
        }

        return this.#span.enqueue(work);

    }

    /** BEGIN IMMEDIATE dengan retry terbatas bila kunci tulis sibuk. */
    async [BEGIN]() {

        for (let attempt = 1; ; attempt += 1) {

            try {
                await this.#span.enqueue(db => runOn(db, "BEGIN IMMEDIATE", []));
                return;
            }
            catch (error) {

                const busy = error?.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(String(error?.message ?? ""));

                if (!busy) {
                    throw error;
                }

                if (attempt >= BEGIN_ATTEMPTS) {
                    throw dbError(CODES.BEGIN_BUSY, "write lock not acquired");
                }

                await new Promise(resolve => setTimeout(resolve, 10 * attempt));

            }

        }

    }

    /** COMMIT / ROLLBACK. Capability ditutup sebelum SQL dikirim. */
    [FINISH](sql) {

        const span = this.#span;

        if (!span.isLive()) {
            return Promise.reject(dbError(CODES.EXPIRED, "transaction already finished"));
        }

        span.seal();

        return span.enqueue(db => runOn(db, sql, []), { closing: true }).catch(error => {
            // COMMIT gagal: transaksi masih terbuka, izinkan ROLLBACK.
            span.unseal();
            throw error;
        });

    }

}

/**
 * Gerbang kepemilikan koneksi. Dipakai bersama oleh backend SQLite dan
 * backend memori (`createMemoryAccStore`) agar kontrak transaksi identik.
 *
 *   - operasi unscoped mengantre FIFO; dari dalam span hidup milik gerbang ini
 *     ia DITOLAK sebelum menyentuh data;
 *   - span memegang antrean; keluar span: seal → drain → settle → retire;
 *   - kerja melebihi `spanDeadlineMs` dipaksa berakhir (antrean dilepas);
 *   - gagal settle = koneksi di-poison.
 */
class TransactionGate {

    #open;
    #settle;
    #deadlineMs;
    #queue = Promise.resolve();
    #poisoned = null;

    /**
     * @param {object} hooks
     * @param {() => Promise<*>} hooks.open  siapkan koneksi, kembalikan handle-nya
     * @param {(connection: *) => Promise<boolean>} hooks.settle  pastikan tidak ada
     *        transaksi tersisa; true bila ada yang terbuka dan sudah di-rollback
     */
    constructor({ open, settle, spanDeadlineMs = DEFAULT_SPAN_DEADLINE_MS }) {
        this.#open = open;
        this.#settle = settle;
        this.#deadlineMs = spanDeadlineMs;
    }

    ensure() {
        return this.#open();
    }

    /** Antrean koneksi: satu unit kerja berjalan setelah unit sebelumnya selesai. */
    acquire(work, { closing = false } = {}) {

        const run = this.#queue.then(() => {
            if (this.#poisoned && !closing) {
                throw dbError(CODES.POISONED, "connection is unusable after a failed rollback; reopen the database", this.#poisoned);
            }
            return work();
        });

        this.#queue = run.then(noop, noop);

        return run;

    }

    /** Span hidup milik gerbang ini pada konteks async saat ini, atau null. */
    #liveSpan() {
        const ctx = SPAN_CONTEXT.getStore();
        return ctx && ctx.gate === this && ctx.span.isLive() ? ctx.span : null;
    }

    unscoped(work, { closing = false } = {}) {

        if (this.#liveSpan()) {
            return Promise.reject(dbError(
                CODES.UNSCOPED,
                "plain Database call inside an open transaction; use the transaction capability"
            ));
        }

        return this.acquire(async () => work(await this.ensure()), { closing });

    }

    exclusive(work) {

        if (this.#liveSpan()) {
            return Promise.reject(dbError(CODES.REENTRANT, "exclusive span cannot be nested inside an open transaction"));
        }

        return this.acquire(() => this.#runSpan(work));

    }

    async #runSpan(work) {

        const span = new Span(this);
        const ctx = { gate: this, span };

        let timer;

        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(dbError(
                CODES.DEADLINE,
                `span exceeded ${this.#deadlineMs} ms; queued callers released`
            )), this.#deadlineMs);
        });

        // Kerja yang terlambat tidak boleh menjadi unhandled rejection setelah deadline.
        const attempt = SPAN_CONTEXT.run(ctx, () => Promise.resolve().then(() => work(span)));
        attempt.catch(noop);

        let value;
        let failure = null;

        try {
            value = await Promise.race([attempt, deadline]);
        }
        catch (error) {
            failure = error;
        }
        finally {
            clearTimeout(timer);
        }

        span.seal();

        await span.drain();

        let dangling;

        try {
            dangling = await this.#settle(await this.ensure());
        }
        catch (error) {
            this.#poisoned = error;
            span.retire();
            throw dbError(CODES.POISONED, "transaction state could not be verified closed; connection poisoned", error);
        }

        span.retire();

        if (failure) {
            throw failure;
        }

        if (dangling) {
            throw dbError(CODES.DANGLING, "span exited with an open transaction; it was rolled back");
        }

        return value;

    }

}

class Database {

    constructor(file, { spanDeadlineMs = DEFAULT_SPAN_DEADLINE_MS } = {}) {

        this.file = file;

        this.db = null;

        this.ready = null;

        this.gate = new TransactionGate({
            open: () => this.ensure(),
            settle: settleConnection,
            spanDeadlineMs
        });

    }

    /**
     * Operasi tanpa capability. Ditolak bila dipanggil dari konteks span yang
     * masih hidup (sebelum menyentuh database); selain itu mengantre di
     * belakang pemilik koneksi.
     */
    unscoped(work) {
        return this.gate.unscoped(work);
    }

    /**
     * Ambil kepemilikan koneksi untuk satu span. Hanya operasi lewat `tx`
     * yang menjadi anggota span ini.
     */
    exclusive(work) {
        return this.gate.exclusive(span => work(new TransactionScope(span)));
    }

    open() {

        if (this.ready) {
            return this.ready;
        }

        this.ready = new Promise((resolve, reject) => {

            fs.mkdirSync(path.dirname(this.file), { recursive: true });

            this.db = new sqlite3.Database(this.file, error => {

                if (error) {
                    return reject(error);
                }

                resolve(this.db);

            });

        }).then(async () => {

            // WAL: pembaca tidak memblokir penulis. Penting karena
            // Console membaca memori sambil daemon terus menulis
            // observasi dari sensor/CCTV.
            await this.execRaw("PRAGMA journal_mode = WAL");

            await this.execRaw("PRAGMA synchronous = NORMAL");

            await this.execRaw("PRAGMA foreign_keys = ON");

            // Beri kesempatan menunggu kunci alih-alih langsung
            // melempar SQLITE_BUSY.
            await this.execRaw("PRAGMA busy_timeout = 5000");

            return this.db;

        });

        return this.ready;

    }

    async ensure() {

        if (!this.db) {
            await this.open();
        }

        return this.db;

    }

    run(sql, params = []) {
        return this.unscoped(db => runOn(db, sql, params));
    }

    get(sql, params = []) {
        return this.unscoped(db => getOn(db, sql, params));
    }

    all(sql, params = []) {
        return this.unscoped(db => allOn(db, sql, params));
    }

    exec(sql) {
        return this.unscoped(db => execOn(db, sql));
    }

    /** exec tanpa antrean; hanya untuk pemanggil yang sudah memegang koneksi. */
    execRaw(sql) {
        return execOn(this.db, sql);
    }

    /**
     * Jalankan sekumpulan operasi dalam satu transaksi. Database memiliki
     * BEGIN IMMEDIATE, COMMIT, dan ROLLBACK; callback hanya menerima `tx`.
     *
     * Sukses callback = COMMIT selesai lebih dulu, baru resolve. Callback gagal
     * = ROLLBACK, lalu error asli dilempar. Kegagalan ROLLBACK tidak ditelan
     * diam-diam: settle gerbang memeriksa keadaan koneksi, dan bila tidak bisa
     * dipastikan bersih koneksi di-poison.
     *
     * Dipakai saat menyimpan memori: baris memories, kaitan
     * entitas, dan indeks FTS harus masuk bersama-sama — memori
     * yang tersimpan tapi tidak terindeks sama saja hilang.
     */
    transaction(work) {

        return this.exclusive(async tx => {

            await tx[BEGIN]();

            let result;

            try {

                result = await work(tx);

                await tx[FINISH]("COMMIT");

            }
            catch (error) {

                // Hasil ROLLBACK diverifikasi oleh settle gerbang, bukan di sini.
                await tx[FINISH]("ROLLBACK").catch(noop);

                throw error;

            }

            return result;

        });

    }

    close() {

        return this.gate.unscoped(() => {

            if (!this.db) {
                return;
            }

            const db = this.db;

            this.db = null;
            this.ready = null;

            return new Promise(resolve => db.close(() => resolve()));

        }, { closing: true });

    }

}

/**
 * Pastikan koneksi tanpa transaksi. ROLLBACK di luar transaksi gagal dengan
 * "no transaction is active"; itu tanda bersih. Sisa transaksi di-rollback
 * dan dilaporkan (true). Kegagalan lain = keadaan tidak pasti (throw).
 */
async function settleConnection(db) {

    try {
        await execOn(db, "ROLLBACK");
        return true;
    }
    catch (error) {
        if (/no transaction is active/i.test(String(error?.message ?? ""))) {
            return false;
        }
        throw error;
    }

}

function runOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.run(sql, params, function (error) {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve({
                lastID: this.lastID,
                changes: this.changes
            });

        });

    });

}

function getOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.get(sql, params, (error, row) => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve(row ?? null);

        });

    });

}

function allOn(db, sql, params) {

    return new Promise((resolve, reject) => {

        db.all(sql, params, (error, rows) => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve(rows ?? []);

        });

    });

}

function execOn(db, sql) {

    return new Promise((resolve, reject) => {

        db.exec(sql, error => {

            if (error) {
                return reject(decorate(error, sql));
            }

            resolve();

        });

    });

}

/** Sertakan potongan SQL pada error agar mudah dilacak. */
function decorate(error, sql) {

    error.message = `${error.message} — SQL: ${
        String(sql).replace(/\s+/g, " ").trim().slice(0, 160)
    }`;

    return error;

}

module.exports = Database;
module.exports.CODES = CODES;
module.exports.TransactionGate = TransactionGate;
module.exports.isTransactionControl = isTransactionControl;
