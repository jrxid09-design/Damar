const path = require("node:path");

const Database = require("./Database");
const migrate = require("./migrate");

const logger = require("../../utils/logger");

const DEFAULT_FILE = path.join(
    __dirname, "..", "..", "..", "data", "memory.db"
);

/**
 * Basis data memori dipisahkan dari data/aether.db yang menyimpan
 * riwayat percakapan lama, supaya skema lama tidak perlu diubah
 * dan basis memori bisa dipindahkan/di-backup sendiri.
 */
const database = new Database(
    process.env.AETHER_MEMORY_DB ?? DEFAULT_FILE
);

let initialized = null;

async function initialize() {

    if (initialized) {
        return initialized;
    }

    initialized = (async () => {

        await database.open();

        const executed = await migrate(database, { logger });

        if (executed.length === 0) {
            logger.info("[memory] skema sudah mutakhir");
        }

        return database;

    })();

    return initialized;

}

module.exports = {
    database,
    initialize,
    file: database.file
};
