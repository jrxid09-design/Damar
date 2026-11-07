# Trust Foundation — Durable Backing (Stage 1)

> Scope: infrastructure prerequisites ONLY. This document covers the secure
> Vault cipher provider, the durable Audit Ledger sink, and the durable
> Device Identity store. It does NOT describe OwnerTrustRegistry, owner
> bootstrap, admin, owner credentials, channel bindings, or cross-channel
> trust — those are explicitly later stages and are NOT implemented here.

## 1. Production Vault protection (cipher boundary)

The Vault core (`src/runtime/vault`) deliberately invents NO cryptography and
forbids crypto primitives inside its own structural boundary
(`tests/vault/structural.test.js`). Secure at-rest protection is therefore
supplied by a **platform provider** implementing the existing
`CipherAdapter` contract (`src/runtime/vault/cipher.js`).

Provider: `src/runtime/vaultProviders/aesGcmCipher.js`
(`createProductionCipherAdapter`).

- **Algorithm:** AES-256-GCM (AEAD) via `node:crypto` only — no crypto
  framework added.
- **Envelope (versioned):** `{ k: "aead-gcm-v1", iv, tag, d }` — random
  12-byte IV per envelope (non-deterministic), 16-byte GCM auth tag.
- **Integrity:** wrong key, tampered/truncated ciphertext, corrupt envelope,
  or unsupported envelope version all fail closed (GCM auth failure).
- **No plaintext at rest:** only the envelope is ever persisted; the secret
  value is never written to durable storage, never logged, never embedded in
  a thrown error.

### Master-key provenance (sealed — never hard-coded, never committed)

This stage owns ONLY the cipher boundary. How the canonical runtime obtains
master protection material is decided by a LATER Owner Trust stage.

The adapter resolves the 32-byte key from, in priority order:

1. `options.keyMaterial` — `Buffer` (32B) or hex/base64 string;
2. `options.keyFile` — path to a `0o600` file holding the key;
3. `process.env.DAMAR_VAULT_MASTER_KEY` — hex/base64 string.

**Fail-closed:** if the production cipher is requested but no usable key
material is available, construction throws `VAULT_CIPHER_REQUIRED`. There is
deliberately NO insecure/deterministic fallback, no embedded key, and no
repository-stored master secret.

### Usage

```js
const { createProductionCipherAdapter } = require("src/runtime/vaultProviders");
const cipher = createProductionCipherAdapter({ keyMaterial });
const store = vault.store.createFileSecretStore(dir, { cipher }); // secure: no allowInsecure needed
const vault = vault.createSecretVault({ store, cipher });
```

The file store accepts a `secure: true` adapter without `allowInsecure`;
it continues to refuse the insecure deterministic adapter by default.

## 2. Durable Audit Ledger sink

The canonical Audit Ledger (`src/runtime/auditLedger`) defines a narrow
persistence port (`AuditPersistencePort.append(record)`). This stage adds the
production adapter: `createFileAuditSink(filePath)`.

- **Format:** append-only JSON Lines, one canonical-JSON record per line.
- **Atomic durable append:** the write happens BEFORE the ledger's in-memory
  commit, so a failed write rejects the append atomically — an event is never
  falsely "durably committed" (no sequence advance on failure).
- **Ordering / chain:** sequence is strictly increasing; the per-record
  integrity block (`prevDigest`/`digest`) is verified on open.
- **Restart continuation:** `describeDurable()` reports the observed tail
  (`records`, `lastSequence`, `lastDigest`) for continuing a ledger across
  restart.
- **Corruption / truncation:** a corrupt, truncated, tampered, or
  chain-broken file FAILS CLOSED — the sink enters an explicit `corrupt`
  recovery state and refuses all further appends (never silently appending
  onto a broken chain, never silently resetting history).
- **Redaction:** the record is already redacted by the ledger before it
  reaches the sink; the sink writes only redacted events (no Vault
  secret/proof/token values).

```js
const { createAuditLedger, createFileAuditSink } = require("src/runtime/auditLedger");
const sink = createFileAuditSink("/path/to/audit.jsonl");
const ledger = createAuditLedger({ sink });
ledger.append({ eventType: "trust.owner.enrolled", source: "..." }, { durable: true });
```

## 3. Durable Device Identity store

`DeviceIdentityService` already owns `serialize()` / `restore()`; only the
in-memory `IdentityStore` shipped. This stage adds the durable adapter:
`createFileIdentityStore(filePath)` (also re-exported from
`src/embodiment`).

- **Atomic:** the whole snapshot is written via tmp + rename (mode `0o600`),
  so a crash mid-write never leaves a torn canonical snapshot; overlapping
  writes are serialized through an in-process queue.
- **Restart restoration:** `loadIdentity({ store })` restores register /
  paired / revoked state and binding digests correctly. Transient in-flight
  pairing normalizes to `UNPAIRED` across restart (unchanged semantics).
- **Fail-closed:** a corrupt or shape-invalid snapshot throws
  `PID_INVALID_SERIALIZATION` — it NEVER silently resets to empty identity
  state. `DeviceIdentityService.restore()` then validates row digests,
  fail-closed.
- **Revocation persists:** a `REVOKED` device stays `REVOKED` after restart.

```js
const { createFileIdentityStore, persistIdentity, loadIdentity } = require("src/embodiment");
const store = createFileIdentityStore("/path/to/identity.json");
await persistIdentity(identityService, store);
const restored = await loadIdentity({ store });
```

The existing `createMemoryIdentityStore` remains available for tests.

## Fail-closed summary

| Component | Failure mode | Behavior |
| --- | --- | --- |
| Vault cipher | no key material | `VAULT_CIPHER_REQUIRED` at construction |
| Vault cipher | wrong key / tamper | GCM auth failure (fail closed) |
| Vault store | insecure adapter | `VAULT_CIPHER_REQUIRED` (no `allowInsecure`) |
| Audit sink | write failure | append rejected atomically (no false success) |
| Audit sink | corrupt/truncated file | explicit corrupt state, refuses appends |
| Identity store | corrupt snapshot | `PID_INVALID_SERIALIZATION` (no silent reset) |

## Ownership boundaries (unchanged)

- Vault: secret values / envelopes only.
- Audit Ledger: immutable security/provenance observations.
- Device Identity: device lifecycle / pairing state.
- Session Continuity, SessionStore, Authority: unchanged.
- No shared catch-all trust database. No owner/admin semantics added.
