"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * Move the legacy database set as one rollback-capable unit.
 * No SQLite connection may be opened until this function returns.
 */
function migrateLegacyDatabase({ dataDir, fsApi = fs }) {
    const names = ["", "-wal", "-shm"];
    const legacyBase = path.join(dataDir, "aether.db");
    const canonicalBase = path.join(dataDir, "damar.db");

    // A canonical main database wins. Never touch an older legacy set.
    if (fsApi.existsSync(canonicalBase)) {
        return { migrated: false, reason: "canonical-exists" };
    }

    const legacy = names
        .map(suffix => ({
            from: legacyBase + suffix,
            to: canonicalBase + suffix
        }))
        .filter(item => fsApi.existsSync(item.from));

    if (!legacy.some(item => item.from === legacyBase)) {
        return { migrated: false, reason: "legacy-absent" };
    }

    // Any target-side artifact would make the resulting set ambiguous.
    if (names.some(suffix => fsApi.existsSync(canonicalBase + suffix))) {
        throw migrationError(
            "DAMAR_DB_MIGRATION_TARGET_CONFLICT",
            "canonical database target is partially occupied"
        );
    }

    const moved = [];
    try {
        for (const item of legacy) {
            fsApi.renameSync(item.from, item.to);
            moved.push(item);
        }
    }
    catch (cause) {
        const rollbackErrors = [];
        for (const item of moved.reverse()) {
            try {
                fsApi.renameSync(item.to, item.from);
            }
            catch (rollbackCause) {
                rollbackErrors.push(rollbackCause);
            }
        }

        const error = migrationError(
            "DAMAR_DB_MIGRATION_FAILED",
            "legacy database set was not migrated",
            cause
        );
        if (rollbackErrors.length) {
            error.code = "DAMAR_DB_MIGRATION_ROLLBACK_FAILED";
            error.rollbackErrors = rollbackErrors;
            error.message += `; rollback failed for ${rollbackErrors.length} file(s)`;
        }
        throw error;
    }

    return { migrated: true, files: legacy.map(item => path.basename(item.to)) };
}

function migrationError(code, message, cause = null) {
    const error = new Error(`${code}: ${message}${cause ? `: ${cause.message}` : ""}`);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

module.exports = { migrateLegacyDatabase };
