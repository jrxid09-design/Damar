"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { invalidInput } = require("./errors");
const { VaultError } = require("./errors");
const { assertSecretId, normalizeSecretIdInput } = require("./ids");
const { buildSecretRecord } = require("./record");
const { assertCipherAdapter, DETERMINISTIC_TEST_ADAPTER } = require("./cipher");

/**
 * SecretStore — the PERSISTENCE BOUNDARY of the vault.
 *
 * Contract (all synchronous in V1):
 *   get(secretId)            -> frozen record | null
 *   put(record)              -> frozen record  (optimistic version check)
 *   delete(secretId)         -> void
 *   listIds()                -> string[] (unsorted; caller sorts)
 *   describePersistence()    -> { kind, secure, guarantees }
 *
 * Optimistic concurrency: put() carries `expectedVersion` on the
 * record input; a mismatch throws VAULT_CONFLICT and mutates nothing.
 * This is what makes rotation atomic under races.
 */

function conflict(code, message) {
    // Typed, immutable construction. Never mutate a VaultError after
    // construction — instances are frozen (B2).
    return new VaultError(code, message);
}

/**
 * Deterministic in-memory store. Reference implementation and the
 * storage used by every test. State is fully bounded by the vault's
 * maxSecrets check at the facade layer.
 */
function createMemorySecretStore() {
    let records = new Map();
    return Object.freeze({
        get(secretId) {
            const id = assertSecretId(secretId);
            const rec = records.get(id);
            return rec ? rec : null;
        },
        put(record) {
            const current = records.get(assertSecretId(record.secretId));
            if (current && current.version !== record.expectedVersion) {
                throw conflict("VAULT_CONFLICT", "concurrent modification detected");
            }
            // Generation guard: even if versions coincide, a stale writer
            // from a previous incarnation of this id can never overwrite
            // a newly created record.
            if (current && record.expectedVersion !== undefined && record.expectedVersion !== null &&
                record.createdAt !== current.createdAt) {
                throw conflict("VAULT_CONFLICT", "stale writer from previous record generation");
            }
            if (!current && record.expectedVersion !== undefined && record.expectedVersion !== null) {
                throw conflict("VAULT_CONFLICT", "record vanished before update");
            }
            const next = buildSecretRecord({ ...record, version: (current ? current.version : 0) + 1 });
            records.set(next.secretId, next);
            return next;
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
        try {
            return buildSecretRecord(parsed);
        } catch (_) {
            throw conflict("VAULT_STORE_FAILURE", "stored record failed validation");
        }
    }

    return Object.freeze({
        get: readRecord,
        put(record) {
            const current = readRecord(record.secretId);
            if (current && current.version !== record.expectedVersion) {
                throw conflict("VAULT_CONFLICT", "concurrent modification detected");
            }
            // Generation guard: a stale writer from a previous incarnation
            // of this id must never overwrite a newly created record.
            if (current && record.expectedVersion !== undefined && record.expectedVersion !== null &&
                record.createdAt !== current.createdAt) {
                throw conflict("VAULT_CONFLICT", "stale writer from previous record generation");
            }
            // Deletion is terminal for stale writers (B3): a put carrying
            // an expectedVersion against a missing record can never
            // recreate it — including its old envelope.
            if (!current && record.expectedVersion !== undefined && record.expectedVersion !== null) {
                throw conflict("VAULT_CONFLICT", "record vanished before update");
            }
            const nextVersion = (current ? current.version : 0) + 1;
            const next = buildSecretRecord({ ...record, version: nextVersion });
            const payload = { ...next, envelope: next.envelope };
            const file = fileFor(next.secretId);
            const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
            fs.renameSync(tmp, file);
            return next;
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
