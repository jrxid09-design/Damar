const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Migrasi berbasis berkas, dijalankan berurutan sekali saja.
 *
 * Nama berkas menentukan urutan (001_, 002_, ...) dan sekaligus
 * menjadi kunci di tabel schema_migrations, sehingga penambahan
 * migrasi baru tidak mengulang yang lama.
 */
async function migrate(database, { logger = null } = {}) {

    await database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `);

    const applied = new Set(
        (await database.all("SELECT name FROM schema_migrations"))
            .map(row => row.name)
    );

    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter(file => file.endsWith(".sql"))
        .sort();

    const executed = [];

    for (const file of files) {

        if (applied.has(file)) {
            continue;
        }

        const sql = fs.readFileSync(
            path.join(MIGRATIONS_DIR, file),
            "utf8"
        );

        // exec() menjalankan banyak statement sekaligus; ia sudah
        // atomik per pemanggilan di sqlite3, jadi tidak dibungkus
        // transaksi manual (CREATE VIRTUAL TABLE + trigger tidak
        // selalu ramah terhadap BEGIN IMMEDIATE bersarang).
        await database.exec(sql);

        await database.run(
            "INSERT INTO schema_migrations (name) VALUES (?)",
            [file]
        );

        executed.push(file);

        logger?.info(`[memory] migrasi diterapkan: ${file}`);

    }

    return executed;

}

module.exports = migrate;
