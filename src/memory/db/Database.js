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
 * KEPEMILIKAN KONEKSI (R3): satu koneksi hanya boleh dimiliki satu span
 * transaksi pada satu waktu. Operasi dari luar span mengantre sampai span
 * selesai (COMMIT atau ROLLBACK), sehingga penulisan yang tidak terkait
 * tidak pernah masuk ke transaksi subsistem lain.
 */
class Database {

    constructor(file) {

        this.file = file;

        this.db = null;

        this.ready = null;

        this.owned = new AsyncLocalStorage();

        this.queue = Promise.resolve();

    }

    /**
     * Gerbang kepemilikan koneksi. Operasi yang berasal dari dalam span pemilik
     * langsung dijalankan; operasi lain menunggu giliran di antrean.
     * ponytail: konteks async turunan span dianggap bagian dari span; tidak ada
     * pemisahan per pemanggil di dalam span yang sama.
     */
    ownConnection(work) {

        if (this.owned.getStore() === true) {
            return work();
        }

        const run = this.queue.then(() => this.owned.run(true, work));

        this.queue = run.then(() => {}, () => {});

        return run;

    }

    /** Ambil kepemilikan koneksi untuk satu unit kerja. */
    exclusive(work) {

        return this.ownConnection(work);

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

        return this.ownConnection(async () => {

            const db = await this.ensure();

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

        });

    }

    get(sql, params = []) {

        return this.ownConnection(async () => {

            const db = await this.ensure();

            return new Promise((resolve, reject) => {

                db.get(sql, params, (error, row) => {

                    if (error) {
                        return reject(decorate(error, sql));
                    }

                    resolve(row ?? null);

                });

            });

        });

    }

    all(sql, params = []) {

        return this.ownConnection(async () => {

            const db = await this.ensure();

            return new Promise((resolve, reject) => {

                db.all(sql, params, (error, rows) => {

                    if (error) {
                        return reject(decorate(error, sql));
                    }

                    resolve(rows ?? []);

                });

            });

        });

    }

    exec(sql) {

        return this.ownConnection(async () => {

            await this.ensure();

            return this.execRaw(sql);

        });

    }

    /** exec tanpa gerbang kepemilikan; hanya untuk pemanggil yang sudah memilikinya. */
    execRaw(sql) {

        return new Promise((resolve, reject) => {

            this.db.exec(sql, error => {

                if (error) {
                    return reject(decorate(error, sql));
                }

                resolve();

            });

        });

    }

    /**
     * Jalankan sekumpulan operasi dalam satu transaksi.
     *
     * Dipakai saat menyimpan memori: baris memories, kaitan
     * entitas, dan indeks FTS harus masuk bersama-sama — memori
     * yang tersimpan tapi tidak terindeks sama saja hilang.
     */
    transaction(work) {

        return this.exclusive(async () => {

            await this.run("BEGIN IMMEDIATE");

            try {

                const result = await work(this);

                await this.run("COMMIT");

                return result;

            }

            catch (error) {

                try {
                    await this.run("ROLLBACK");
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

        return this.ownConnection(() => {

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

/** Sertakan potongan SQL pada error agar mudah dilacak. */
function decorate(error, sql) {

    error.message = `${error.message} — SQL: ${
        String(sql).replace(/\s+/g, " ").trim().slice(0, 160)
    }`;

    return error;

}

module.exports = Database;
