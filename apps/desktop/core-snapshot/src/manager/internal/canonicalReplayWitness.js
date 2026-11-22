"use strict";

/* Separate durable replay-head witness; never co-locate it with the audit ack. */
const fs = require("node:fs");
const path = require("node:path");

function createCanonicalReplayWitness(file) {
    if (typeof file !== "string" || file.trim() === "") throw new TypeError("replay witness file required");
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    function read() {
        if (!fs.existsSync(resolved)) return { seq: 0, token: null };
        const rows = fs.readFileSync(resolved, "utf8").split(/\r?\n/).filter(Boolean);
        if (rows.length === 0) return { seq: 0, token: null };
        const row = JSON.parse(rows[rows.length - 1]);
        if (!Number.isSafeInteger(row.seq) || row.seq < 0 || (row.token !== null && typeof row.token !== "string")) throw new Error("REPLAY_WITNESS_INVALID");
        return { seq: row.seq, token: row.token };
    }
    function commit(seq, token) {
        if (!Number.isSafeInteger(seq) || seq < 0 || typeof token !== "string") throw new Error("REPLAY_WITNESS_INVALID_COMMIT");
        const prior = read();
        if (seq < prior.seq) throw new Error("REPLAY_WITNESS_ROLLBACK");
        if (seq === prior.seq && token !== prior.token) throw new Error("REPLAY_WITNESS_TOKEN_MISMATCH");
        const fd = fs.openSync(resolved, "a", 0o600);
        try { fs.writeSync(fd, JSON.stringify({ seq, token }) + "\n"); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
    }
    return Object.freeze({ filePath: resolved, read, commit });
}

module.exports = Object.freeze({ createCanonicalReplayWitness });
