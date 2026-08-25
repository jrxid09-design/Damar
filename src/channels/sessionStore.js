const fs = require("node:fs");
const path = require("node:path");

const sqlite3 = require("sqlite3");

/**
 * Penyimpanan sesi percakapan lintas kanal — sumber kebenaran konteks
 * obrolan yang PERSISTEN (selamat dari restart daemon).
 *
 * Prinsip "SQLite-first, no hidden state":
 * percakapan tak lagi disimpan di `Map` dalam memori (hilang saat
 * restart) melainkan di satu tabel SQLite dengan grammar kunci sesi
 * `channel:<kanal>:dm:<peer>` / `channel:<kanal>:group:<peer>`.
 *
 * Satu koneksi serial (sama seperti lapisan memori) — SQLite menulis
 * serial, menambah koneksi hanya menambah risiko SQLITE_BUSY.
 */
const DEFAULT_FILE = path.join(__dirname, "..", "..", "data", "channels.db");

const MAX_TURNS = 20; // jendela giliran per sesi (setara perilaku lama)

class SessionStore {

    constructor(file = process.env.AETHER_CHANNEL_DB ?? DEFAULT_FILE) {

        this.file = file;

        this.db = null;
        this.ready = null;

    }

    /** Buka database + buat skema (idempoten). Malas: hanya saat dipakai. */
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

                this.db.run("PRAGMA journal_mode = WAL", () => {});

                const ddl = `
                    CREATE TABLE IF NOT EXISTS channel_sessions (
                        key        TEXT PRIMARY KEY,
                        channel    TEXT NOT NULL,
                        kind       TEXT NOT NULL DEFAULT 'dm',
                        peer       TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        turns      INTEGER NOT NULL DEFAULT 0,
                        payload    TEXT NOT NULL DEFAULT '[]'
                    )
                `;

                this.db.run(ddl, error => error ? reject(error) : resolve());

            });

        });

        return this.ready;

    }

    /** Wrapper promise untuk db.get. */
    get(sql, params = []) {

        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (error, row) =>
                error ? reject(error) : resolve(row));
        });

    }

    /** Wrapper promise untuk db.all. */
    all(sql, params = []) {

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (error, rows) =>
                error ? reject(error) : resolve(rows));
        });

    }

    /** Wrapper promise untuk db.run. */
    run(sql, params = []) {

        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (error) {
                error ? reject(error) : resolve(this);
            });
        });

    }

    /**
     * Grammar kunci sesi yang stabil dan dapat diurai ulang:
     *   channel:<kanal>:dm:<peer>
     *   channel:<kanal>:group:<peer>
     */
    static sessionKey(channel, peer, kind = "dm") {

        return `channel:${channel}:${kind}:${String(peer)}`;

    }

    /**
     * Muat giliran percakapan sebuah sesi (array {role, content}).
     * Sesi baru mengembalikan array kosong — tanpa galat.
     */
    async load(key) {

        await this.open();

        const row = await this.get(
            "SELECT payload FROM channel_sessions WHERE key = ?",
            [key]
        );

        if (!row) {
            return [];
        }

        try {
            return JSON.parse(row.payload);
        }
        catch {
            return [];
        }

    }

    /**
     * Tambah satu giliran ke sesi; jendela dijaga pada MAX_TURNS terakhir.
     * `meta` = { channel, kind, peer } untuk kolom indeks.
     */
    async append(key, turn, meta = {}) {

        await this.open();

        const turns = await this.load(key);

        turns.push({ role: turn.role, content: turn.content });

        while (turns.length > MAX_TURNS) {
            turns.shift();
        }

        const channel = meta.channel ?? key.split(":")[1] ?? "unknown";
        const kind = meta.kind ?? key.split(":")[2] ?? "dm";
        const peer = meta.peer ?? key.split(":").slice(3).join(":") ?? "";

        await this.run(
            `INSERT INTO channel_sessions (key, channel, kind, peer, updated_at, turns, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
                updated_at = excluded.updated_at,
                turns       = excluded.turns,
                payload     = excluded.payload`,
            [key, channel, kind, peer, Date.now(), turns.length, JSON.stringify(turns)]
        );

        return turns;

    }

    /** Kosongkan percakapan sesi (perintah /reset). */
    async clear(key) {

        await this.open();

        await this.run("DELETE FROM channel_sessions WHERE key = ?", [key]);

    }

    /** Daftar sesi yang tersimpan (untuk panel/bidang kendali). */
    async list({ channel = null } = {}) {

        await this.open();

        const rows = channel
            ? await this.all(
                "SELECT key, channel, kind, peer, updated_at, turns FROM channel_sessions WHERE channel = ? ORDER BY updated_at DESC",
                [channel]
            )
            : await this.all(
                "SELECT key, channel, kind, peer, updated_at, turns FROM channel_sessions ORDER BY updated_at DESC"
            );

        return rows;

    }

    close() {

        if (this.db) {
            this.db.close();
            this.db = null;
            this.ready = null;
        }

    }

}

module.exports = { SessionStore, sessionStore: new SessionStore(), MAX_TURNS };
