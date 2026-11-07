# ACC Security Boundary

Status: design-freeze C0. Enforcement tests: `tests/cognition/accSecurityBoundary.test.js`
(bagian dari `accAutobiographySubstrateSecurity.test.js`).

## Invariant utama

**COGNITION NEVER GRANTS AUTHORITY.**

1. **Arah dependensi**: `ACC → foundation`. Tidak ada file di
   `Authorization`, `requestIdentity`, `RuntimeExecutor`, `ToolBus`,
   `riskPolicy`, `ssrfGuard` yang me-require `src/cognition/**`.
   Diverifikasi statis tiap run gate.

2. **Tanpa jalur eksekusi/jaringan**: seluruh `src/cognition/**` bebas dari
   `child_process`, `fetch(`, `node:http(s)`, `net`, `dgram`,
   `ToolRegistry.execute`, `ToolBus.execute(`, `eval(`, `process.exit`.
   ACC tidak bisa "melakukan" apa pun — ia hanya menghasilkan
   `CognitiveProposal` (MODEL_HYPOTHESIS).

3. **Kognisi internal = zero authority** (§40/§97): setiap
   `CognitiveRequest` memakai jalur identitas kanonik foundation dengan
   `capabilitySet=[]` dibekukan dan `tools=[]`. Diverifikasi behavioral:
   `disclosureFilter(anyTools, exec).length === 0` dan
   `assertExecution(tool, exec)` → `PERMISSION_DENIED` untuk tool mana pun.

4. **Affect ≠ authority** (§22): frustrasi/goalPressure/resourcePressure
   maksimum TIDAK mengubah hasil `Authorization.assertExecution` —
   diverifikasi identik sebelum/sesudah akumulasi state.

5. **Shadow-only** (§5): default `DAMAR_ACC=off` (nol jejak store);
   mode `shadow` hanya observasi/persist/appraise/workspace/witness/
   predict/encode. Tidak ada mode yang mengubah tool selection, role,
   capabilitySet, routing provider, atau respons produksi.

6. **Event trust boundary** (§13–§14): hanya tipe terdaftar dengan
   producer sah yang bermutasi state. Klaim user → `USER_CLAIM`;
   output model → `MODEL_HYPOTHESIS`; keduanya disimpan TERPISAH dan
   tidak pernah menulis field otoritatif self.

7. **Rantai hash jurnal** (§51) mendeteksi korupsi/kecelakaan secara
   praktis; ini BUKAN klaim anti-tamper terhadap attacker lokal
   ber-privilese atas file DB.

## FOUNDATION_CHANGE_REQUIRED

Belum ada. Seluruh implementasi C0 konsumsi permukaan publik
(telemetry bus, ToolStats read-view, Database wrapper + migrasi additive,
primitif Authorization).
