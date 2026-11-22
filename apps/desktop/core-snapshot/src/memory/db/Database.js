const sqlite3 = require("sqlite3");
const path = require("node:path");
const fs = require("node:fs");

/**
 * Pembungkus Promise di atas node-sqlite3 yang berbasis callback.
 *
 * Seluruh lapisan memori memakai satu koneksi. SQLite menulis
 * secara serial, jadi menambah koneksi tidak menambah throughput
 * tulis — yang ada malah menaikkan risiko SQLITE_BUSY.
 */
class Database {

    constructor(file) {

        this.file = file;

        this.db = null;

        this.ready = null;

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
            await this.exec("PRAGMA journal_mode = WAL");

            await this.exec("PRAGMA synchronous = NORMAL");

            await this.exec("PRAGMA foreign_keys = ON");

            // Beri kesempatan menunggu kunci alih-alih langsung
            // melempar SQLITE_BUSY.
            await this.exec("PRAGMA busy_timeout = 5000");

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

    async run(sql, params = []) {

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

    }

    async get(sql, params = []) {

        const db = await this.ensure();

        return new Promise((resolve, reject) => {

            db.get(sql, params, (error, row) => {

                if (error) {
                    return reject(decorate(error, sql));
                }

                resolve(row ?? null);

            });

        });

    }

    async all(sql, params = []) {

        const db = await this.ensure();

        return new Promise((resolve, reject) => {

            db.all(sql, params, (error, rows) => {

                if (error) {
                    return reject(decorate(error, sql));
                }

                resolve(rows ?? []);

            });

        });

    }

    async exec(sql) {

        const db = await this.ensure();

        return new Promise((resolve, reject) => {

            db.exec(sql, error => {

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
    async transaction(work) {

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

    }

    async close() {

        if (!this.db) {
            return;
        }

        const db = this.db;

        this.db = null;
        this.ready = null;

        return new Promise(resolve => db.close(() => resolve()));

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
