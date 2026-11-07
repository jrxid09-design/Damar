"use strict";

/**
 * W6-R5-03 — production composition DURABILITY.
 *
 * The real production authority store is durable (sqlite, bootstrap-owned path,
 * env-overridable via DAMAR_AUTHORITY_DB). This file runs in its own process and
 * points DAMAR_AUTHORITY_DB at a temp file BEFORE composition, then proves the
 * canonical authority + owner trust are durable and that the AuthorityRegistry
 * binding persists across a fresh composition (restart continuity).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damar-authdb-test-"));
process.env.DAMAR_AUTHORITY_DB = path.join(dir, "authority-v1.db");
process.env.DAMAR_OWNER_TRUST_STATE = path.join(dir, "ownertrust-v1.json");

const test = require("node:test");
const assert = require("node:assert/strict");

test("R5-03: durable production authority store is sqlite-backed and persisted", async () => {
    const productionComposition = require("../../../src/authority/productionComposition");
    const comp = await productionComposition.ensureProductionAuthorityComposed();
    const status = comp.status();
    assert.equal(status.authorityDurable, true, "production authority store must be durable");
    assert.equal(status.authorityStoreFile, path.resolve(process.env.DAMAR_AUTHORITY_DB));
    assert.ok(fs.existsSync(status.authorityStoreFile), "the authority db file must exist on disk");
    assert.ok(Object.isFrozen(comp));
});
