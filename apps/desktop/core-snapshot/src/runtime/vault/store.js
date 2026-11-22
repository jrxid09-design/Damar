"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { invalidInput } = require("./errors");
const { VaultError } = require("./errors");
const { assertSecretId, normalizeSecretIdInput } = require("./ids");
const { buildSecretRecord, generateIncarnationId } = require("./record");
const { assertCipherAdapter, DETERMINISTIC_TEST_ADAPTER } = require("./cipher");

/**
 * SecretStore — the PERSISTENCE BOUNDARY of the vault.
 *
 * Contract (all synchronous in V1):
 *   get(secretId)            -> frozen record | null
 *   create(createIntent)     -> frozen record  (CREATE ONLY)
 *   put(record)              -> frozen record  (UPDATE ONLY)
 *   delete(secretId)         -> void
 *   listIds()                -> string[] (unsorted; caller sorts)
 *   describePersistence()    -> { kind, secure, guarantees }
 *
 * SPLIT CREATE / UPDATE (R32):
 *
 *   create(createIntent) is the ONLY way a record comes into existence.
 *   It requires the id to be ABSENT, mints a fresh incarnationId, and
 *   forces version = 1. It MUST NOT accept a previously persisted
 *   canonical record: store-owned lifecycle fields (incarnationId,
 *   version, expectedVersion) are REJECTED, never silently overwritten.
 *   This structurally prevents a captured stale canonical record from
 *   being replayed as a new create (which would resurrect its envelope).
 *
 *   put(record) is UPDATE ONLY. It requires an explicit positive
 *   expectedVersion, an existing record at exactly that version, and an
 *   incoming incarnationId equal to the current incarnation. Every
 *   violation throws VAULT_CONFLICT and mutates nothing.
 *
 * Optimistic concurrency is what makes rotation atomic under races.
 */

function conflict(code, message) {
    // Typed, immutable construction. Never mutate a VaultError after
    // construction — instances are frozen (B2).
    return new VaultError(code, message);
}

/** Store-owned lifecycle fields a create intent must never carry. */
const CREATE_FORBIDDEN_FIELDS = Object.freeze([
    "incarnationId",
    "version",
    "expectedVersion"
]);

/**
 * Validates that `input` is CREATE INTENT, not a persisted canonical
 * record. A canonical persisted record carries store-owned lifecycle
 * fields; their presence means the caller is attempting to replay an
 * already-persisted record (including its envelope) as a fresh create.
 */
function assertCreateIntent(input) {
    for (const key of CREATE_FORBIDDEN_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined && input[key] !== null) {
            throw conflict("VAULT_CONFLICT", `create intent must not carry persisted field "${key}"`);
        }
    }
}

/**
 * Shared create/update semantics used by BOTH memory and file stores so
 * the two backends are structurally identical.
 *
 * @param {object} record  the incoming record (create intent or update)
 * @param {(secretId: string) => object|null} getRecord
 * @param {(record: object) => void} persist   called once, atomically
 */
function applyCreate(createIntent, getRecord, persist) {
    assertCreateIntent(createIntent);
    const secretId = assertSecretId(createIntent.secretId);
    if (getRecord(secretId) !== null) {
        throw conflict("VAULT_CONFLICT", "record already exists");
    }
    const next = buildSecretRecord({
        ...createIntent,
        incarnationId: generateIncarnationId(),
        version: 1
    });
    persist(next);
    return next;
}

function applyPut(record, getRecord, persist) {
    const secretId = assertSecretId(record.secretId);
    const expectedVersion = record.expectedVersion;
    // UPDATE ONLY: a bare canonical record (no expectedVersion) and a
    // create-style expectedVersion:0 are both invalid here.
    if (expectedVersion === undefined || expectedVersion === null) {
        throw conflict("VAULT_CONFLICT", "update requires an explicit expectedVersion");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
        throw conflict("VAULT_CONFLICT", "expectedVersion must be a positive integer");
    }
    const current = getRecord(secretId);
    if (current === null) {
        throw conflict("VAULT_CONFLICT", "record vanished before update");
    }
    if (current.version !== expectedVersion) {
        throw conflict("VAULT_CONFLICT", "concurrent modification detected");
    }
    // Incarnation guard: a stale writer from a previous creation lifetime
    // can never overwrite the current record, even when version and
    // createdAt coincide. incarnationId — NOT createdAt — is identity.
    if (current.incarnationId !== record.incarnationId) {
        throw conflict("VAULT_CONFLICT", "incarnationId mismatch");
    }
    const next = buildSecretRecord({ ...record, version: current.version + 1 });
    persist(next);
    return next;
}

/**
 * Deterministic in-memory store. Reference implementation and the
 * storage used by every test. State is fully bounded by the vault's
 * maxSecrets check at the facade layer.
 */
function createMemorySecretStore() {
    let records = new Map();
    const getRecord = (secretId) => records.get(assertSecretId(secretId)) ?? null;
    return Object.freeze({
        get(secretId) {
            return getRecord(secretId);
        },
        create(createIntent) {
            return applyCreate(createIntent, getRecord, (next) => {
                records.set(next.secretId, next);
            });
        },
        put(record) {
            return applyPut(record, getRecord, (next) => {
                records.set(next.secretId, next);
            });
        },
        delete(secretId) {
            records.delete(assertSecretId(secretId));
        },
        listIds() {
            return Array.from(records.keys());
        },
        describePersistence() {
            return Object.freeze({
                kind: "memory-deterministic",
                secure: false,
                guarantees:
                    "Process memory only. Nothing persists across restarts. " +
                    "Intended for tests and ephemeral sessions — NOT presented as secure."
            });
        },
        _resetForTests() {
            records = new Map();
        }
    });
}

/**
 * JSON-file store. One file per secret inside a directory; writes are
 * atomic (tmp + rename).
 *
 * STORAGE GUARANTEES: envelopes are stored exactly as produced by the
 * cipher adapter. With a secure platform adapter this is suitable as
 * an encrypted-at-rest boundary. WITHOUT one, the store refuses to
 * start unless `allowInsecure: true` is passed explicitly — plaintext
 * persistence must never be presented as secure.
 */
function createFileSecretStore(dirPath, options = {}) {
    if (typeof dirPath !== "string" || dirPath.length === 0) {
        throw invalidInput("file store requires a directory path");
    }
    const adapter = assertCipherAdapter(options.cipher ?? DETERMINISTIC_TEST_ADAPTER);
    const allowInsecure = options.allowInsecure === true;
    if (!adapter.secure && !allowInsecure) {
        throw conflict(
            "VAULT_CIPHER_REQUIRED",
            `cipher adapter "${adapter.id}" does not protect data at rest; ` +
                "pass allowInsecure:true to accept PLAINTEXT-INSECURE storage explicitly"
        );
    }

    fs.mkdirSync(dirPath, { recursive: true });

    function fileFor(secretId) {
        return path.join(dirPath, `${secretId}.json`);
    }

    function readRecord(secretId) {
        const file = fileFor(assertSecretId(secretId));
        let raw;
        try {
            raw = fs.readFileSync(file, "utf8");
        } catch (_) {
            return null;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            throw conflict("VAULT_STORE_FAILURE", "stored record is corrupt");
        }
        // Envelope decryption happens ONLY in the resolver path, never
        // at load time, so metadata listing never touches cleartext.
        // generate:false — a persisted record missing/malformed
        // incarnationId must FAIL CLOSED, never be silently re-rolled
        // (which would change record-lifetime identity across reopen).
        try {
            return buildSecretRecord(parsed, { generate: false });
        } catch (_) {
            throw conflict("VAULT_STORE_FAILURE", "stored record failed validation");
        }
    }

    function persist(next) {
        const payload = { ...next, envelope: next.envelope };
        const file = fileFor(next.secretId);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }

    return Object.freeze({
        get: readRecord,
        create(createIntent) {
            return applyCreate(createIntent, readRecord, persist);
        },
        put(record) {
            return applyPut(record, readRecord, persist);
        },
        delete(secretId) {
            const file = fileFor(assertSecretId(normalizeSecretIdInput(secretId)));
            try {
                fs.unlinkSync(file);
            } catch (_) {
                /* already gone */
            }
        },
        listIds() {
            const out = [];
            for (const name of fs.readdirSync(dirPath)) {
                if (!name.endsWith(".json")) continue;
                const candidate = name.slice(0, -5);
                try {
                    out.push(assertSecretId(candidate));
                } catch (_) {
                    /* foreign or corrupt filename: skip, never crash listing */
                }
            }
            return out.sort();
        },
        describePersistence() {
            return Object.freeze({
                kind: `file-json:${adapter.id}`,
                secure: adapter.secure,
                guarantees: adapter.secure
                    ? `Envelopes encrypted at rest via "${adapter.id}": ${adapter.guarantees}`
                    : `PLAINTEXT-INSECURE (explicitly acknowledged): ${adapter.guarantees}`
            });
        }
    });
}

module.exports = Object.freeze({
    createMemorySecretStore,
    createFileSecretStore
});
