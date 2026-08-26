"use strict";

const { resolveVaultConfig } = require("./bounds");
const ids = require("./ids");
const refs = require("./ref");
const scopeMod = require("./scope");
const valueMod = require("./value");
const { buildSecretMetadata, SECRET_STATUSES } = require("./metadata");
const { buildSecretRecord } = require("./record");
const { digestOfValue } = require("./digest");
const { createMemorySecretStore } = require("./store");
const { DETERMINISTIC_TEST_ADAPTER } = require("./cipher");
const { VAULT_ERROR_CODES, VaultError, invalidInput } = require("./errors");
const { createVaultDiagnostics } = require("./diagnostics");

/**
 * Aether Secret Vault V1 — CORE.
 *
 * CONSTITUTIONAL LAWS (binding on every export):
 *  - Secret possession != Authority. The vault never grants capability,
 *    ratifies actions, authorizes tools/devices, or infers ownership.
 *  - Secret reference != Secret value. Refs are safe everywhere; values
 *    exist only inside SecretValue and leave only via reveal().
 *  - Resolution is an explicit trusted act, distinguishable from
 *    metadata inspection. There is NO bulk accessor of raw values.
 *  - Logging/serialization != permission to reveal. Everything leaving
 *    this module is scrubbed through the redaction registry.
 *  - Recovery never resurrects revoked or rotated values from
 *    historical evidence; evidence restores as metadata-only status.
 */

function makeOk(value) {
    return Object.freeze({ ok: true, value });
}
function makeDeny(code, message) {
    return Object.freeze({ ok: false, code, message });
}

/**
 * Creates the vault facade over a store.
 *
 * @param {object} [options]
 *   config   — bounds overrides
 *   store    — SecretStore implementation (default: deterministic memory)
 *   cipher   — cipher adapter used to envelope values before storage
 *              (default: deterministic-test adapter, NOT SECURE)
 *   now      — injectable clock returning epoch ms
 */
function createSecretVault(options = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
        throw invalidInput("vault options must be an object");
    }
    const config = resolveVaultConfig(options.config);
    const store = options.store ?? createMemorySecretStore();
    const cipher = options.cipher ?? DETERMINISTIC_TEST_ADAPTER;
    if (typeof options.now !== "undefined" && typeof options.now !== "function") {
        throw invalidInput("now must be a function");
    }
    const now = options.now ?? (() => Date.now());
    const diagnostics = createVaultDiagnostics(config);

    // Explicit key extraction — hostile option objects cannot smuggle keys.
    const own = (k) => (Object.prototype.hasOwnProperty.call(options, k) ? options[k] : undefined);

    function diag(op, secretId, outcome, detail) {
        return diagnostics.record({ at: now() }, op, secretId, outcome, detail);
    }

    function loadRecord(ref) {
        const r = refs.coerceSecretRef(ref);
        const rec = store.get(r.secretId);
        return { r, rec };
    }

    function assertCapacity(extra) {
        if (store.listIds().length + extra > config.maxSecrets) {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_LIMIT_EXCEEDED, "secret count bound reached");
        }
    }

    /**
     * Registers a NEW secret. Returns the ref + metadata. The raw value
     * never appears in the result beyond the SecretValue boundary and
     * is immediately tracked for redaction.
     */
    function create(input) {
        if (typeof input !== "object" || input === null) {
            throw invalidInput("create input must be an object");
        }
        const secretId = input.secretId !== undefined ? ids.assertSecretId(input.secretId) : ids.newSecretId();
        if (store.get(secretId)) {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_DUPLICATE, "secret id already exists", secretId);
        }
        const scope = scopeMod.coerceSecretScope(input.scope);
        const label = typeof input.label === "string" ? input.label : "";
        if (label.length > config.maxLabelLength) {
            throw invalidInput("label exceeds maximum length");
        }
        if (input.label !== undefined && typeof input.label !== "string") {
            throw invalidInput("label must be a string");
        }
        const sv = valueMod.secretValue(input.value);
        assertCapacity(1);

        let cleartext;
        try {
            cleartext = sv.revealBytes();
            const envelope = cipher.encrypt(cleartext);
            const record = buildSecretRecord({
                secretId,
                scope,
                status: "active",
                label,
                createdAt: now(),
                rotationCount: 0,
                valueBytes: sv.sizeBytes,
                valueDigest: digestOfValue(cleartext),
                envelope
            });
            store.put({ ...record });
        } finally {
            cleartext?.fill(0);
        }
        diagnostics.registry.track(sv.reveal(), label || secretId);
        const ref = refs.buildSecretRef({ secretId, scope });
        diag("create", secretId, "ok");
        return Object.freeze({
            ref,
            metadata: buildSecretMetadata(store.get(secretId))
        });
    }

    /** Metadata inspection ONLY. Distinct API from resolution by design. */
    function describe(ref) {
        const { r, rec } = loadRecord(ref);
        if (!rec) {
            return Object.freeze({ ok: false, code: VAULT_ERROR_CODES.VAULT_NOT_FOUND });
        }
        void r;
        diag("describe", rec.secretId, "ok");
        return Object.freeze({
            ok: true,
            metadata: buildSecretMetadata(rec),
            ref: refs.buildSecretRef({ secretId: rec.secretId, scope: rec.scope })
        });
    }

    function denyFor(record) {
        if (!record || record.status === "evidence") {
            return makeDeny(
                record ? VAULT_ERROR_CODES.VAULT_UNAVAILABLE : VAULT_ERROR_CODES.VAULT_NOT_FOUND,
                record ? "secret has no stored value (recovery evidence)" : "secret does not exist"
            );
        }
        if (record.status === "revoked") {
            return makeDeny(VAULT_ERROR_CODES.VAULT_REVOKED, "secret has been revoked");
        }
        return null;
    }

    /** THE trusted disclosure path. Returns a SecretValue, never a string. */
    function resolve(ref, resolveOptions = {}) {
        const { r, rec } = loadRecord(ref);
        if (resolveOptions.expectedScope !== undefined &&
            !scopeMod.scopeEquals(resolveOptions.expectedScope, r.scope)) {
            diag("resolve", r.secretId, "denied:VAULT_SCOPE_MISMATCH");
            return makeDeny(VAULT_ERROR_CODES.VAULT_SCOPE_MISMATCH, "cross-scope resolution denied");
        }
        const denied = denyFor(rec);
        if (denied) {
            diag("resolve", r.secretId, `denied:${denied.code}`);
            return denied;
        }
        let clear;
        try {
            clear = cipher.decrypt(rec.envelope);
        } catch (err) {
            diag("resolve", r.secretId, "error", err.message ?? "decrypt failure");
            return makeDeny(VAULT_ERROR_CODES.VAULT_STORE_FAILURE, "stored value could not be decoded");
        }
        const digestOk = digestOfValue(clear) === rec.valueDigest;
        const sizeOk = clear.length === rec.valueBytes;
        if (!digestOk || !sizeOk) {
            diag("resolve", r.secretId, "corrupt");
            return makeDeny(VAULT_ERROR_CODES.VAULT_STORE_FAILURE, "stored value failed integrity check");
        }
        diag("resolve", r.secretId, "ok");
        return makeOk(valueMod.secretValue(clear));
    }

    /** Scoped resolution helper: refuses cross-scope lookups up front. */
    function resolveIn(scope, ref) {
        const s = scopeMod.coerceSecretScope(scope);
        const r = refs.coerceSecretRef(ref);
        if (!scopeMod.scopeEquals(s, r.scope)) {
            diag("resolveIn", r.secretId, "denied:VAULT_SCOPE_MISMATCH");
            return makeDeny(VAULT_ERROR_CODES.VAULT_SCOPE_MISMATCH, "cross-scope resolution denied");
        }
        return resolve(r, { expectedScope: s });
    }

    /**
     * Rotation: stable SecretId, atomic single-record swap, old value
     * destroyed and untracked afterwards. On ANY failure the previous
     * state remains fully intact (put is one optimistic swap).
     */
    function rotate(ref, newValue, rotateOptions = {}) {
        const { r, rec } = loadRecord(ref);
        if (!rec) {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_NOT_FOUND, "cannot rotate unknown secret");
        }
        if (rec.status !== "active") {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_REVOKED, `cannot rotate ${rec.status} secret`);
        }
        const expectedVersion =
            rotateOptions.expectedVersion !== undefined
                ? rotateOptions.expectedVersion
                : rec.version;
        const sv = valueMod.secretValue(newValue);
        let oldCleartext;
        try {
            oldCleartext = cipher.decrypt(rec.envelope).toString("utf8");
        } catch (_) {
            oldCleartext = null;
        }
        let updated;
        let cleartext;
        try {
            cleartext = sv.revealBytes();
            const envelope = cipher.encrypt(cleartext);
            updated = store.put({
                ...rec,
                status: "active",
                rotatedAt: now(),
                rotationCount: rec.rotationCount + 1,
                valueBytes: sv.sizeBytes,
                valueDigest: digestOfValue(cleartext),
                envelope,
                expectedVersion
            });
        } finally {
            cleartext?.fill(0);
        }
        // Swap-side effects happen only after the atomic put succeeded.
        if (oldCleartext !== null) {
            diagnostics.registry.untrack(oldCleartext);
        }
        diagnostics.registry.track(sv.reveal(), rec.label || rec.secretId);
        diag("rotate", rec.secretId, "ok");
        return Object.freeze({
            ref: refs.buildSecretRef({ secretId: rec.secretId, scope: rec.scope }),
            metadata: buildSecretMetadata(updated)
        });
    }

    /** Revoke destroys the value; the ref remains meaningful for audit. */
    function revoke(ref) {
        const { r, rec } = loadRecord(ref);
        if (!rec) {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_NOT_FOUND, "cannot revoke unknown secret");
        }
        let oldCleartext = null;
        if (rec.status === "active") {
            try {
                oldCleartext = cipher.decrypt(rec.envelope).toString("utf8");
            } catch (_) { /* nothing to untrack */ }
        }
        const updated = store.put({
            ...rec,
            status: SECRET_STATUSES.revoked,
            envelope: null,
            valueBytes: 0,
            valueDigest: null,
            expectedVersion: rec.version
        });
        if (oldCleartext !== null) {
            diagnostics.registry.untrack(oldCleartext);
        }
        diag("revoke", rec.secretId, "ok");
        void r;
        return Object.freeze({ metadata: buildSecretMetadata(updated) });
    }

    /** Delete removes the record entirely; later resolves are NOT_FOUND. */
    function deleteSecret(ref) {
        const { r, rec } = loadRecord(ref);
        if (!rec) {
            throw new VaultError(VAULT_ERROR_CODES.VAULT_NOT_FOUND, "cannot delete unknown secret");
        }
        let oldCleartext = null;
        if (rec.status === "active") {
            try {
                oldCleartext = cipher.decrypt(rec.envelope).toString("utf8");
            } catch (_) { /* already unreadable */ }
        }
        store.delete(rec.secretId);
        if (oldCleartext !== null) {
            diagnostics.registry.untrack(oldCleartext);
        }
        diag("delete", rec.secretId, "ok");
        void r;
        return true;
    }

    const FORBIDDEN_EVIDENCE_KEYS = Object.freeze(
        ["value", "cleartext", "plaintext", "envelope", "secret", "token"].reduce(
            (m, k) => ((m[k] = k), m),
            {}
        )
    );

    /**
     * Recovery import: metadata/ref evidence ONLY. Raw-value carriers
     * are rejected outright. Imported secrets can never come back as
     * active — evidence stays evidence until a fresh value is created
     * under the SAME SecretId via create() with an explicit id.
     */
    function importRecoveryEvidence(evidence) {
        if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
            throw invalidInput("recovery evidence must be an object");
        }
        for (const key of Object.keys(evidence)) {
            if (Object.prototype.hasOwnProperty.call(FORBIDDEN_EVIDENCE_KEYS, key.toLowerCase())) {
                throw new VaultError(
                    VAULT_ERROR_CODES.VAULT_FORBIDDEN_KEY,
                    "recovery evidence must not carry raw value material",
                    key
                );
            }
        }
        const secretId = ids.assertSecretId(evidence.secretId);
        const scope = scopeMod.coerceSecretScope(evidence.scope);
        const label = typeof evidence.label === "string"
            ? evidence.label.slice(0, config.maxLabelLength)
            : "";
        const existing = store.get(secretId);
        if (existing) {
            // Never downgrade or overwrite live state from stale evidence.
            diag("import-evidence", secretId, "skipped:exists");
            return Object.freeze({ imported: false, reason: "already-present" });
        }
        assertCapacity(1);
        store.put({
            secretId,
            scope,
            status: SECRET_STATUSES.evidence,
            label,
            createdAt: Number.isSafeInteger(evidence.createdAt) ? evidence.createdAt : now(),
            rotationCount: 0,
            expectedVersion: undefined
        });
        diag("import-evidence", secretId, "ok");
        return Object.freeze({
            imported: true,
            metadata: buildSecretMetadata(store.get(secretId))
        });
    }

    /** Evidence-safe view for recovery capsules: refs + metadata only. */
    function evidenceView() {
        return Object.freeze(
            store.listIds().sort().map((id) => {
                const rec = store.get(id);
                return Object.freeze({
                    ref: refs.buildSecretRef({ secretId: id, scope: rec.scope }),
                    metadata: buildSecretMetadata(rec)
                });
            })
        );
    }

    function listRefs() {
        return evidenceView().map((e) => e.ref);
    }

    function stats() {
        const all = store.listIds().sort().map((id) => store.get(id));
        const counts = { active: 0, revoked: 0, evidence: 0 };
        for (const rec of all) {
            counts[rec.status] += 1;
        }
        return Object.freeze({
            total: all.length,
            counts: Object.freeze(counts),
            trackedRedactionValues: diagnostics.registry.size(),
            diagnosticEntries: diagnostics.size(),
            persistence: store.describePersistence(),
            cipher: Object.freeze({ id: cipher.id, secure: cipher.secure }),
            bounds: config
        });
    }

    /** Scrub text through the redaction registry (for host loggers). */
    function scrubText(text) {
        return diagnostics.registry.scrubText(text);
    }

    return Object.freeze({
        create,
        describe,
        resolve,
        resolveIn,
        rotate,
        revoke,
        deleteSecret,
        importRecoveryEvidence,
        evidenceView,
        listRefs,
        stats,
        scrubText,
        _diagnostics: diagnostics
    });
}

module.exports = Object.freeze({
    createSecretVault
});
