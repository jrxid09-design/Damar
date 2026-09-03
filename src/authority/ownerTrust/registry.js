"use strict";

/**
 * OwnerTrustRegistry — canonical Owner/Admin trust domain records.
 *
 * Records (smallest actual schema):
 *   OwnerTrustRecord      { principalId, kind:"owner", state, generation,
 *                           credentials:[credentialId], enrolledAtMs }
 *   AdminDelegationRecord { principalId, kind:"admin", state, generation,
 *                           credentials:[credentialId], delegatedBy, createdAtMs,
 *                           expiresAtMs|null, revokedAtMs|null }
 *   CredentialDescriptor  { credentialId, principalId, publicKeyPem,
 *                           vaultRef, generation, createdAtMs, revokedAtMs|null,
 *                           rotatedFromCredentialId|null }
 *   PrincipalBinding      { bindingId, principalId, kind:"device"|"transport",
 *                           peer, deviceId|null, generation, method,
 *                           createdAtMs, revokedAtMs|null, proofRef|null }
 *
 * The registry holds PUBLIC VERIFIER material (Ed25519 public keys) and
 * Vault REFERENCES.  Private keys live ONLY in the Vault (vaultRef points at
 * the sealed envelope); they are never stored, logged, or returned here.
 *
 * AUTHORITY remains the sole permission decision maker.  This registry
 * records TRUST, never grants.
 */

const crypto = require("node:crypto");

const {
    OWNER_STATES,
    PRINCIPAL_KINDS,
    BINDING_KINDS,
    RECORD_VERSION
} = require("./types");

const PRINCIPAL_ID_PATTERN = /^[a-z][a-z0-9-]{2,62}$/;
const MAX_PRINCIPALS = 64;
const MAX_CREDENTIALS = 256;
const MAX_BINDINGS = 512;
const PEER_MAX = 128;

function fail(code, message) {
    const error = new Error(`[${code}] ${message || code}`);
    error.code = code;
    return error;
}

function deepFreeze(value) {
    if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

function copyOf(value) {
    return value === undefined ? {} : JSON.parse(JSON.stringify(value));
}

function assertPrincipalId(value) {
    if (typeof value !== "string" || !PRINCIPAL_ID_PATTERN.test(value)) {
        throw fail("OT_PRINCIPAL_INVALID", "principalId malformed");
    }
    return value;
}

function assertPeer(value, label) {
    if (typeof value !== "string" || value.length === 0 || value.length > PEER_MAX) {
        throw fail("OT_PEER_INVALID", `${label || "peer"} malformed`);
    }
    if (!/^[\x20-\x7E]+$/.test(value)) {
        throw fail("OT_PEER_INVALID", `${label || "peer"} contains control characters`);
    }
    return value;
}

function randomId(prefix) {
    return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * createOwnerTrustRegistry({ store, clock, audit })
 *
 *   store  — ownerTrust durable store (createOwnerTrustStore or memory-shaped
 *            { save, load }); optional (in-memory when absent).
 *   clock  — () => ms.
 *   audit  — optional canonical Audit Ledger append fn (safe, redacted events).
 */
async function createOwnerTrustRegistry({ store = null, clock = () => Date.now(), audit = null } = {}) {
    if (typeof clock !== "function") {
        throw fail("OT_CLOCK_INVALID", "clock must be a function");
    }

    // ---- live in-memory state (NEVER escapes as mutable reference) --------
    const state = {
        state: OWNER_STATES.UNENROLLED,
        bootstrapped: false,          // first-Owner path permanently closed once true
        owner: null,                  // OwnerTrustRecord
        admins: new Map(),            // principalId -> AdminDelegationRecord
        credentials: new Map(),       // credentialId -> CredentialDescriptor
        bindings: new Map(),          // bindingId -> PrincipalBinding
        generation: 0                 // global trust generation (increments on root mutation)
    };

    function emitAudit(eventType, metadata) {
        if (typeof audit !== "function") return;
        try {
            audit({ eventType, source: "authority.ownerTrust", metadata });
        } catch { /* audit failure must never break the trust flow */ }
    }

    function snapshot() {
        return deepFreeze({
            version: RECORD_VERSION,
            state: state.state,
            bootstrapped: state.bootstrapped,
            generation: state.generation,
            owner: copyOf(state.owner),
            admins: [...state.admins.values()].map((a) => copyOf(a)),
            credentials: [...state.credentials.values()].map((c) => copyOf(c)),
            bindings: [...state.bindings.values()].map((b) => copyOf(b))
        });
    }

    async function persist() {
        if (!store) return;
        await store.save(copyOf(snapshot()));
    }

    async function restore() {
        if (!store) return Object.freeze({ restored: false, reason: "NO_STORE" });
        let data;
        try {
            data = await store.load();
        } catch (error) {
            // Corrupt/unreadable initialized state MUST NOT become UNENROLLED.
            state.state = OWNER_STATES.RECOVERY_REQUIRED;
            return Object.freeze({ restored: false, degraded: true, reason: error.code ?? "OT_INVALID_SERIALIZATION" });
        }
        if (data === null) {
            return Object.freeze({ restored: false, reason: "ABSENT" });
        }
        if (typeof data.state !== "string" || !Object.values(OWNER_STATES).includes(data.state)) {
            state.state = OWNER_STATES.RECOVERY_REQUIRED;
            return Object.freeze({ restored: false, degraded: true, reason: "STATE_INVALID" });
        }
        state.state = data.state;
        state.bootstrapped = data.bootstrapped === true;
        state.generation = Number.isSafeInteger(data.generation) ? data.generation : 0;
        state.owner = data.owner && typeof data.owner === "object" ? data.owner : null;
        state.admins = new Map((Array.isArray(data.admins) ? data.admins : []).map((a) => [a.principalId, a]));
        state.credentials = new Map((Array.isArray(data.credentials) ? data.credentials : []).map((c) => [c.credentialId, c]));
        state.bindings = new Map((Array.isArray(data.bindings) ? data.bindings : []).map((b) => [b.bindingId, b]));
        return Object.freeze({ restored: true, state: state.state });
    }

    // ---- reads (frozen copies only) ---------------------------------------
    function getState() {
        return state.state;
    }
    function isBootstrapped() {
        return state.bootstrapped;
    }
    function getGeneration() {
        return state.generation;
    }
    function getOwner() {
        return state.owner ? deepFreeze(copyOf(state.owner)) : null;
    }
    function getPrincipal(principalId) {
        if (state.owner && state.owner.principalId === principalId) {
            return deepFreeze(copyOf(state.owner));
        }
        const admin = state.admins.get(principalId);
        return admin ? deepFreeze(copyOf(admin)) : null;
    }
    function principalState(principalId) {
        if (state.owner && state.owner.principalId === principalId) {
            return state.owner.state;
        }
        const admin = state.admins.get(principalId);
        return admin ? admin.state : null;
    }
    function getCredential(credentialId) {
        const c = state.credentials.get(credentialId);
        return c ? deepFreeze(copyOf(c)) : null;
    }
    function credentialsFor(principalId) {
        return deepFreeze([...state.credentials.values()].filter((c) => c.principalId === principalId).map((c) => copyOf(c)));
    }
    function bindingsFor(principalId) {
        return deepFreeze([...state.bindings.values()].filter((b) => b.principalId === principalId).map((b) => copyOf(b)));
    }
    function findBinding({ kind, peer }) {
        for (const b of state.bindings.values()) {
            if (b.kind === kind && b.peer === peer && b.revokedAtMs === null) {
                return deepFreeze(copyOf(b));
            }
        }
        return null;
    }

    // ---- bootstrap state (Stage 3 uses this) -------------------------------
    /**
     * The ONLY mutation that can ever flip UNENROLLED -> bootstrapped.  It is
     * invoked by the sealed first-Owner provisioning ceremony AFTER proof
     * verification succeeds.  Permanently closes the first-Owner path.
     * Exactly one caller may win; subsequent calls fail closed.
     */
    async function completeFirstBootstrap({ principalId, credential }) {
        if (state.bootstrapped || state.owner !== null) {
            throw fail("OT_BOOTSTRAP_CLOSED", "first-Owner bootstrap is permanently closed");
        }
        assertPrincipalId(principalId);
        if (!credential || typeof credential !== "object") {
            throw fail("OT_CREDENTIAL_INVALID", "bootstrap credential descriptor required");
        }
        const credentialId = credential.credentialId;
        if (typeof credentialId !== "string" || credentialId.length === 0) {
            throw fail("OT_CREDENTIAL_INVALID", "credentialId required");
        }
        if (state.credentials.has(credentialId)) {
            throw fail("OT_CREDENTIAL_CONFLICT", "credentialId already exists");
        }
        if (typeof credential.publicKeyPem !== "string" || credential.publicKeyPem.length === 0) {
            throw fail("OT_CREDENTIAL_INVALID", "public verifier key required");
        }
        if (state.credentials.size >= MAX_CREDENTIALS) {
            throw fail("OT_BOUND_EXCEEDED", "credential bound reached");
        }

        const now = clock();
        state.generation += 1;
        const gen = state.generation;
        const credRecord = Object.freeze({
            credentialId,
            principalId,
            publicKeyPem: credential.publicKeyPem,
            vaultRef: typeof credential.vaultRef === "string" ? credential.vaultRef : null,
            generation: gen,
            createdAtMs: now,
            revokedAtMs: null,
            rotatedFromCredentialId: null
        });
        const ownerRecord = Object.freeze({
            principalId,
            kind: PRINCIPAL_KINDS.OWNER,
            state: OWNER_STATES.ACTIVE,
            generation: gen,
            credentials: [credentialId],
            enrolledAtMs: now
        });
        state.credentials.set(credentialId, credRecord);
        state.owner = ownerRecord;
        state.state = OWNER_STATES.ACTIVE;
        state.bootstrapped = true;
        await persist();
        emitAudit("trust.owner.activated", { principalId, credentialId, generation: gen });
        return deepFreeze({ principalId, credentialId, generation: gen });
    }

    // ---- credential rotation / revocation ----------------------------------
    async function rotateCredential({ principalId, newCredential }) {
        const principal = requireActivePrincipal(principalId);
        if (!newCredential || typeof newCredential.publicKeyPem !== "string" || newCredential.publicKeyPem.length === 0) {
            throw fail("OT_CREDENTIAL_INVALID", "new public verifier key required");
        }
        const oldIds = principal.credentials;
        const now = clock();
        state.generation += 1;
        const gen = state.generation;
        const newId = newCredential.credentialId;
        if (typeof newId !== "string" || newId.length === 0 || state.credentials.has(newId)) {
            throw fail("OT_CREDENTIAL_CONFLICT", "new credentialId invalid or already exists");
        }
        const newRecord = Object.freeze({
            credentialId: newId,
            principalId,
            publicKeyPem: newCredential.publicKeyPem,
            vaultRef: typeof newCredential.vaultRef === "string" ? newCredential.vaultRef : null,
            generation: gen,
            createdAtMs: now,
            revokedAtMs: null,
            rotatedFromCredentialId: oldIds[oldIds.length - 1] ?? null
        });
        state.credentials.set(newId, newRecord);
        // Revoke old credentials (old proofs rejected; stable principal retained).
        for (const oldId of oldIds) {
            const old = state.credentials.get(oldId);
            if (old && old.revokedAtMs === null) {
                state.credentials.set(oldId, Object.freeze({ ...old, revokedAtMs: now }));
            }
        }
        if (state.owner && state.owner.principalId === principalId) {
            state.owner = Object.freeze({ ...state.owner, generation: gen, credentials: [newId] });
        } else {
            const admin = state.admins.get(principalId);
            if (admin) state.admins.set(principalId, Object.freeze({ ...admin, generation: gen, credentials: [newId] }));
        }
        await persist();
        emitAudit("trust.credential.rotated", { principalId, credentialId: newId, generation: gen });
        return deepFreeze({ principalId, credentialId: newId, generation: gen });
    }

    async function revokeCredential({ credentialId }) {
        const cred = state.credentials.get(credentialId);
        if (!cred) throw fail("OT_CREDENTIAL_NOT_FOUND", "credential unknown");
        if (cred.revokedAtMs !== null) {
            return deepFreeze({ credentialId, revokedAtMs: cred.revokedAtMs, idempotent: true });
        }
        const now = clock();
        state.generation += 1;
        state.credentials.set(credentialId, Object.freeze({ ...cred, revokedAtMs: now }));
        await persist();
        emitAudit("trust.credential.revoked", { credentialId, generation: state.generation });
        return deepFreeze({ credentialId, revokedAtMs: now });
    }

    // ---- Admin delegation (Stage 5 detail) ---------------------------------
    async function addAdmin({ principalId, delegatedBy, credential, expiresAtMs = null }) {
        const owner = requireActiveOwner();
        assertPrincipalId(principalId);
        if (principalId === owner.principalId) {
            throw fail("OT_ADMIN_CONFLICT", "Owner cannot be delegated as its own Admin");
        }
        assertPrincipalId(delegatedBy);
        if (delegatedBy !== owner.principalId) {
            throw fail("OT_NOT_OWNER", "only the active Owner may delegate Admin");
        }
        if (state.admins.has(principalId)) {
            throw fail("OT_ADMIN_CONFLICT", "admin principal already exists");
        }
        if (state.admins.size >= MAX_PRINCIPALS) {
            throw fail("OT_BOUND_EXCEEDED", "principal bound reached");
        }
        if (!credential || typeof credential.publicKeyPem !== "string" || credential.publicKeyPem.length === 0) {
            throw fail("OT_CREDENTIAL_INVALID", "admin public verifier key required");
        }
        const credentialId = credential.credentialId;
        if (typeof credentialId !== "string" || credentialId.length === 0 || state.credentials.has(credentialId)) {
            throw fail("OT_CREDENTIAL_CONFLICT", "credentialId invalid or already exists");
        }
        const now = clock();
        if (expiresAtMs !== null && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now)) {
            throw fail("OT_ADMIN_INVALID", "expiresAtMs must be a future timestamp or null");
        }
        state.generation += 1;
        const gen = state.generation;
        state.credentials.set(credentialId, Object.freeze({
            credentialId,
            principalId,
            publicKeyPem: credential.publicKeyPem,
            vaultRef: typeof credential.vaultRef === "string" ? credential.vaultRef : null,
            generation: gen,
            createdAtMs: now,
            revokedAtMs: null,
            rotatedFromCredentialId: null
        }));
        state.admins.set(principalId, Object.freeze({
            principalId,
            kind: PRINCIPAL_KINDS.ADMIN,
            state: OWNER_STATES.ACTIVE,
            generation: gen,
            credentials: [credentialId],
            delegatedBy,
            createdAtMs: now,
            expiresAtMs,
            revokedAtMs: null
        }));
        await persist();
        emitAudit("trust.admin.added", { principalId, delegatedBy, generation: gen });
        return deepFreeze({ principalId, credentialId, generation: gen });
    }

    async function revokeAdmin({ principalId }) {
        const admin = state.admins.get(principalId);
        if (!admin) throw fail("OT_ADMIN_NOT_FOUND", "admin unknown");
        if (admin.revokedAtMs !== null) {
            return deepFreeze({ principalId, revokedAtMs: admin.revokedAtMs, idempotent: true });
        }
        const now = clock();
        state.generation += 1;
        state.admins.set(principalId, Object.freeze({ ...admin, state: OWNER_STATES.RECOVERY_REQUIRED, revokedAtMs: now }));
        await persist();
        emitAudit("trust.admin.revoked", { principalId, generation: state.generation });
        return deepFreeze({ principalId, revokedAtMs: now });
    }

    // ---- principal ↔ device / transport bindings (Stages 6-7 detail) --------
    async function addBinding({ principalId, kind, peer, deviceId = null, method, proofRef = null }) {
        requireActivePrincipal(principalId);
        if (kind !== BINDING_KINDS.DEVICE && kind !== BINDING_KINDS.TRANSPORT) {
            throw fail("OT_BINDING_INVALID", "binding kind must be device|transport");
        }
        assertPeer(peer, "binding peer");
        if (kind === BINDING_KINDS.DEVICE && (typeof deviceId !== "string" || deviceId.length === 0)) {
            throw fail("OT_BINDING_INVALID", "device binding requires a deviceId");
        }
        if (typeof method !== "string" || method.length === 0) {
            throw fail("OT_BINDING_INVALID", "binding verification method required");
        }
        if (state.bindings.size >= MAX_BINDINGS) {
            throw fail("OT_BOUND_EXCEEDED", "binding bound reached");
        }
        // Conflicting active binding for the same (kind, peer) to a DIFFERENT
        // principal is rejected (channel account reassignment must not silently
        // transfer trust).
        for (const b of state.bindings.values()) {
            if (b.kind === kind && b.peer === peer && b.revokedAtMs === null && b.principalId !== principalId) {
                throw fail("OT_BINDING_CONFLICT", "peer is already bound to another principal");
            }
        }
        const now = clock();
        state.generation += 1;
        const gen = state.generation;
        const bindingId = randomId("bind");
        state.bindings.set(bindingId, Object.freeze({
            bindingId,
            principalId,
            kind,
            peer,
            deviceId: kind === BINDING_KINDS.DEVICE ? deviceId : null,
            generation: gen,
            method,
            createdAtMs: now,
            revokedAtMs: null,
            proofRef: typeof proofRef === "string" ? proofRef : null
        }));
        await persist();
        emitAudit(kind === BINDING_KINDS.DEVICE ? "trust.device.bound" : "trust.channel.bound",
            { principalId, peer, kind, generation: gen });
        return deepFreeze({ bindingId, principalId, kind, peer, generation: gen });
    }

    async function revokeBinding({ bindingId }) {
        const binding = state.bindings.get(bindingId);
        if (!binding) throw fail("OT_BINDING_NOT_FOUND", "binding unknown");
        if (binding.revokedAtMs !== null) {
            return deepFreeze({ bindingId, revokedAtMs: binding.revokedAtMs, idempotent: true });
        }
        const now = clock();
        state.generation += 1;
        state.bindings.set(bindingId, Object.freeze({ ...binding, revokedAtMs: now }));
        await persist();
        emitAudit(binding.kind === BINDING_KINDS.DEVICE ? "trust.device.revoked" : "trust.channel.revoked",
            { bindingId, generation: state.generation });
        return deepFreeze({ bindingId, revokedAtMs: now });
    }

    // ---- guards --------------------------------------------------------------
    function requireActiveOwner() {
        if (!state.owner || state.owner.state !== OWNER_STATES.ACTIVE || !state.bootstrapped) {
            throw fail("OT_NOT_ACTIVE", "no active Owner");
        }
        return state.owner;
    }
    function requireActivePrincipal(principalId) {
        const pState = principalState(principalId);
        if (pState !== OWNER_STATES.ACTIVE) {
            throw fail("OT_PRINCIPAL_NOT_ACTIVE", "principal is not active");
        }
        const p = getPrincipal(principalId);
        if (p && p.revokedAtMs) {
            throw fail("OT_PRINCIPAL_NOT_ACTIVE", "principal is revoked");
        }
        return p;
    }

    return Object.freeze({
        // reads
        getState,
        isBootstrapped,
        getGeneration,
        getOwner,
        getPrincipal,
        principalState,
        getCredential,
        credentialsFor,
        bindingsFor,
        findBinding,
        snapshot,
        // lifecycle
        restore,
        persist,
        // mutations (sealed composition drives these; see bootstrap/proof modules)
        completeFirstBootstrap,
        rotateCredential,
        revokeCredential,
        addAdmin,
        revokeAdmin,
        addBinding,
        revokeBinding
    });
}

module.exports = Object.freeze({ createOwnerTrustRegistry });
