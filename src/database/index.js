const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "aether.db");

const db = new sqlite3.Database(dbPath, (err) => {

    if (err) {

        console.error(
            "SQLite connection failed:",
            err.message
        );

    }

});

module.exports = db;