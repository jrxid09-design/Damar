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
 * Konteks async (AsyncLocalStorage) TIDAK memberi kepemilikan. ALS hanya
 * dipakai untuk mendeteksi panggilan tanpa capability dari dalam span yang
 * masih hidup; panggilan itu ditolak sebelum menyentuh database. Panggilan
 * dari luar span mengantre sampai COMMIT atau ROLLBACK selesai.
 */

const UNSCOPED_CODE = "UNSCOPED_DB_CALL_DURING_ACTIVE_TRANSACTION";
const EXPIRED_CODE = "TX_CAPABILITY_EXPIRED";
const REENTRANT_CODE = "DB_SPAN_REENTRANT";

const FINISH = Symbol("finish");
const DRAIN = Symbol("drain");
const SEAL = Symbol("seal");
const IS_LIVE = Symbol("isLive");

const noop = () => {};

function dbError(code, message) {
    return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Capability satu span transaksi. Opaque: tidak bisa diserialisasi dan mati
 * setelah span selesai. Operasi di dalam span berjalan berurutan (FIFO)
 * pada koneksi milik span.
 */
class TransactionScope {

    #db;
    #open = true;
    #chain = Promise.resolve();

    constructor(db) {
        this.#db = db;
    }

    run(sql, params = []) {
        return this.#enqueue(connection => runOn(connection, sql, params));
    }

    get(sql, params = []) {
        return this.#enqueue(connection => getOn(connection, sql, params));
    }

    all(sql, params = []) {
        return this.#enqueue(connection => allOn(connection, sql, params));
    }

    exec(sql) {
        return this.#enqueue(connection => execOn(connection, sql));
    }

    toJSON() {
        throw dbError(EXPIRED_CODE, "transaction capability is not serializable");
    }

    [IS_LIVE]() {
        return this.#open;
    }

    /** COMMIT / ROLLBACK. Capability ditutup sebelum SQL dikirim. */
    [FINISH](sql) {

        if (!this.#open) {
            return Promise.reject(dbError(EXPIRED_CODE, "transaction already finished"));
        }

        this.#open = false;

        const run = this.#chain.then(() => runOn(this.#db.db, sql, []));

        this.#chain = run.then(noop, noop);

        return run.catch(error => {
            // COMMIT gagal: transaksi masih terbuka, izinkan ROLLBACK.
            this.#open = true;
            throw error;
        });

    }

    /** Tunggu operasi yang masih antre. */
    async [DRAIN]() {
        await this.#chain;
    }

    [SEAL]() {
        this.#open = false;
    }

    #enqueue(work) {

        if (!this.#open) {
            return Promise.reject(dbError(EXPIRED_CODE, "transaction capability is no longer usable"));
        }

        const run = this.#chain.then(() => work(this.#db.db));

        this.#chain = run.then(noop, noop);

        return run;

    }

}

class Database {

    constructor(file) {

        this.file = file;

        this.db = null;

        this.ready = null;

        // Hanya untuk diagnosis dan deteksi panggilan tanpa capability.
        // Keberadaan konteks ini TIDAK berarti kepemilikan transaksi.
        this.owned = new AsyncLocalStorage();

        this.queue = Promise.resolve();

    }

    /** Span yang masih hidup pada konteks async ini, atau null. */
    liveScope() {
        const scope = this.owned.getStore();
        return scope && scope[IS_LIVE]() ? scope : null;
    }

    /** Antrean koneksi: satu unit kerja berjalan setelah unit sebelumnya selesai. */
    acquire(work) {

        const run = this.queue.then(work);

        this.queue = run.then(noop, noop);

        return run;

    }

    /**
     * Operasi tanpa capability. Ditolak bila dipanggil dari konteks span yang
     * masih hidup (sebelum menyentuh database); selain itu mengantre di
     * belakang pemilik koneksi.
     */
    unscoped(work) {

        if (this.liveScope()) {
            return Promise.reject(dbError(
                UNSCOPED_CODE,
                "plain Database call inside an open transaction; use the transaction capability"
            ));
        }

        return this.acquire(async () => {
            await this.ensure();
            return work(this.db);
        });

    }

    /**
     * Ambil kepemilikan koneksi untuk satu span. Hanya operasi lewat `tx`
     * yang menjadi anggota span ini.
     */
    exclusive(work) {

        if (this.liveScope()) {
            return Promise.reject(dbError(
                REENTRANT_CODE,
                "exclusive span cannot be nested inside an open transaction"
            ));
        }

        return this.acquire(async () => {

            await this.ensure();

            const scope = new TransactionScope(this);

            try {
                return await this.owned.run(scope, () => work(scope));
            }
            finally {
                await scope[DRAIN]();
                scope[SEAL]();
            }

        });

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
     * Jalankan sekumpulan operasi dalam satu transaksi. Callback menerima `tx`;
     * seluruh penulisan harus lewat `tx`.
     *
     * Dipakai saat menyimpan memori: baris memories, kaitan
     * entitas, dan indeks FTS harus masuk bersama-sama — memori
     * yang tersimpan tapi tidak terindeks sama saja hilang.
     */
    transaction(work, { begin = tx => tx.run("BEGIN IMMEDIATE") } = {}) {

        return this.exclusive(async tx => {

            await begin(tx);

            try {

                const result = await work(tx);

                await tx[FINISH]("COMMIT");

                return result;

            }

            catch (error) {

                try {
                    await tx[FINISH]("ROLLBACK");
                }
                catch {
                    // Rollback bisa gagal bila koneksi sudah bermasalah;
                    // error aslinya yang lebih berguna untuk dilempar.
                }

                throw error;

            }

        });

    }

    close() {

        return this.unscoped(() => {

            if (!this.db) {
                return;
            }

            const db = this.db;

            this.db = null;
            this.ready = null;

            return new Promise(resolve => db.close(() => resolve()));

        });

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
