"use strict";

/**
 * W8-IW1 test substrate for the EXTERNAL rollback anchor port (P0-2).
 *
 * The replay ledger accepts a `rollbackAnchor` port whose head lives OUTSIDE the
 * rollback domain. This helper implements that port contract on a separate
 * directory so tests can exercise the REAL guarantee: rolling the replay state
 * back alone is detected (REPLAY_ROLLBACK_DETECTED) and fails closed.
 *
 * This is a TEST DOUBLE of the port interface, not a production anchor. A
 * production anchor must be genuinely external/monotonic (remote, TPM counter or
 * OS-protected append-only store); no such primitive exists in this repository.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCanonicalReplayLedger } = require("../../src/manager/internal/canonicalReplayLedger");

function createFileRollbackAnchor(anchorDir) {
    fs.mkdirSync(anchorDir, { recursive: true });
    const file = path.join(anchorDir, "rollback-anchor.json");
    return {
        read() {
            if (!fs.existsSync(file)) return null;
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            return { seq: data.seq, token: data.token };
        },
        commit(seq, token) {
            // In-place write + fsync through a WRITABLE handle: on Windows,
            // FlushFileBuffers requires write access, so fsync on a "r" handle
            // fails EPERM. Mirrors the ledger's Windows durability path.
            const fd = fs.openSync(file, "w", 0o600);
            try {
                fs.writeSync(fd, JSON.stringify({ seq, token }));
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
        }
    };
}

/** A replay ledger whose rollback anchor lives outside the replay root. */
function createRollbackResistantLedger({ replayRoot, anchorRoot, file } = {}) {
    const root = replayRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "damar-replay-"));
    const anchorDir = anchorRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "damar-anchor-"));
    return createCanonicalReplayLedger({
        file: file ?? path.join(root, "replay.sqlite"),
        rollbackAnchor: createFileRollbackAnchor(anchorDir)
    });
}

module.exports = { createFileRollbackAnchor, createRollbackResistantLedger };
