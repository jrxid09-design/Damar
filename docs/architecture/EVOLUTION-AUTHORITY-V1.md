# Evolution Authority V1 — arsitektur ringkas

Parent: foundation `214d74a` → ACC C0 `2890f96`.
Branch: `feat/evolution-authority-v1`.

## Prinsip

    DAMAR OWNS ITS EVOLUTION.
    THE OWNER RATIFIES MATERIAL TRANSITIONS.

- **Delegation != Escalation.** Tanpa ratifikasi baru,
  Authority(child) ⊆ Authority(parent) (`attenuateGrant`, subset law).
- **Ratification = penciptaan authority BARU** oleh owner; sah melebihi
  root sebelumnya karena bukan delegasi dari grant lama.
- **Self-understanding ≠ authority.** identity.md / self-model / jurnal /
  hipotesis ACC / output tool boleh MENGAJUKAN proposal; hanya
  OwnerRatification APPROVED yang menghasilkan grant nyata.

## Modul

| File | Tanggung jawab |
|---|---|
| `src/authority/canonical.js` | CapabilityId kanonik (L-D2) + RestrictionSet fail-closed (L-D1) |
| `src/authority/model.js` | STATUS/transisi lifecycle, pabrik Grant/Ratification/EvolutionProposal, digest binding |
| `src/authority/delegation.js` | `attenuateGrant` — subset law per field |
| `src/authority/store.js` | memory & SQLite backend; `consumeExecution` ATOMIK (BEGIN IMMEDIATE) |
| `src/authority/registry.js` | authorize (machine-readable decision), delegate, suspend/resume/revoke, generation bulk-revoke, propose/revise/ratify, snapshot + revalidasi |
| `src/services/damarSelfService.js` | resolver path kanonik tunggal, migrasi legacy byte-exact, journal append-only |

## Keputusan otoritas

`authorize()` mengembalikan objek (bukan boolean):
`{allowed, reasonCode, decisionId, capabilityId, stage, snapshot}`.
Snapshot = `ExecutionAuthoritySnapshot` frozen; eksekusi material wajib
melewati `revalidateExecution(snapshot)` sehingga urutan
authorize→revoke→execute tidak bisa mem-bypass revocation.

## Persistence

Migrasi `009_authority.sql`: capabilities, capability_events,
capability_consumption, subject_generations, owner_ratifications,
evolution_proposals. Mutasi lifecycle + event audit ditulis dalam satu
transaksi; kegagalan di tengah = rollback penuh (diuji dengan sabotase
tabel events).

## Alur evolusi V1

ACC/self-observation → EvolutionProposal (DRAFT) → dokumen di
`DamarSelf/evolution/proposals` → eksperimen/evidence →
AuthorityExpansionRequest → OWNER_RATIFIED → root grant baru →
(penerapan produksi = milestone berikutnya).

V1 TIDAK melakukan deploy otomatis, tidak ada Pandawa, tidak ada
self-modification produksi tanpa ratifikasi.
