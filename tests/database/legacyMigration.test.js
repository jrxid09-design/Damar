"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { migrateLegacyDatabase } = require("../../src/database/legacyMigration");

function fixture() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-db-migration-"));
    const files = {
        main: path.join(dataDir, "aether.db"),
        wal: path.join(dataDir, "aether.db-wal"),
        shm: path.join(dataDir, "aether.db-shm")
    };
    return { dataDir, files };
}

function cleanup(dataDir) { fs.rmSync(dataDir, { recursive: true, force: true }); }

function seed(files, names = ["main", "wal", "shm"]) {
    for (const name of names) fs.writeFileSync(files[name], Buffer.from(`bytes-${name}`));
}

for (const names of [["main"], ["main", "wal"], ["main", "wal", "shm"]]) {
    test(`migrates legacy set: ${names.join("+")}`, () => {
        const { dataDir, files } = fixture();
        try {
            seed(files, names);
            const result = migrateLegacyDatabase({ dataDir });
            assert.equal(result.migrated, true);
            for (const name of names) {
                assert.equal(fs.existsSync(files[name]), false);
                assert.deepEqual(
                    fs.readFileSync(path.join(dataDir, `damar.db${name === "main" ? "" : `-${name}`}`)),
                    Buffer.from(`bytes-${name}`)
                );
            }
        }
        finally { cleanup(dataDir); }
    });
}

test("canonical database wins and migration is idempotent", () => {
    const { dataDir, files } = fixture();
    try {
        seed(files);
        fs.writeFileSync(path.join(dataDir, "damar.db"), "canonical");
        assert.deepEqual(migrateLegacyDatabase({ dataDir }), {
            migrated: false, reason: "canonical-exists"
        });
        assert.equal(fs.readFileSync(path.join(dataDir, "damar.db"), "utf8"), "canonical");
        const onlyLegacy = fixture();
        try {
            seed(onlyLegacy.files, ["main"]);
            migrateLegacyDatabase({ dataDir: onlyLegacy.dataDir });
            assert.deepEqual(migrateLegacyDatabase({ dataDir: onlyLegacy.dataDir }), {
                migrated: false, reason: "canonical-exists"
            });
        }
        finally { cleanup(onlyLegacy.dataDir); }
    }
    finally { cleanup(dataDir); }
});

function failingFs(failAt) {
    let calls = 0;
    return {
        existsSync: fs.existsSync.bind(fs),
        renameSync(from, to) {
            calls += 1;
            if (calls === failAt) throw new Error(`injected rename failure ${calls}`);
            return fs.renameSync(from, to);
        }
    };
}

for (const failAt of [1, 2, 3]) {
    test(`rename failure ${failAt} rolls back the complete file set`, () => {
        const { dataDir, files } = fixture();
        try {
            seed(files);
            assert.throws(
                () => migrateLegacyDatabase({ dataDir, fsApi: failingFs(failAt) }),
                error => error.code === "DAMAR_DB_MIGRATION_FAILED"
            );
            for (const name of ["main", "wal", "shm"]) {
                assert.equal(fs.existsSync(files[name]), true);
                assert.equal(fs.existsSync(path.join(dataDir, `damar.db${name === "main" ? "" : `-${name}`}`)), false);
            }
        }
        finally { cleanup(dataDir); }
    });
}

test("target-sidecar conflict fails before mutation", () => {
    const { dataDir, files } = fixture();
    try {
        seed(files, ["main", "wal"]);
        fs.writeFileSync(path.join(dataDir, "damar.db-shm"), "occupied");
        assert.throws(
            () => migrateLegacyDatabase({ dataDir }),
            error => error.code === "DAMAR_DB_MIGRATION_TARGET_CONFLICT"
        );
        assert.equal(fs.existsSync(files.main), true);
        assert.equal(fs.existsSync(files.wal), true);
    }
    finally { cleanup(dataDir); }
});
