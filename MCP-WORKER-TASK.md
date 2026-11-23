# MCP-WORKER-TASK — MCP Eksekusi General + Wiring agentfed

Brief tugas untuk dikerjakan di worktree `C:\Workspace\Damar-mcp-worker`,
branch `feat/mcp-worker-bridge` (dari `develop` @ `f0391ad1`).
Sumber temuan: recon 23 Nov 2026 atas checkout `C:\Workspace\Damar` (develop terbaru).

Ada DUA pekerjaan: **A. MCP eksekusi general** dan **B. Wiring `src/agentfed/`**.
Keduanya satu rangkaian: A membuka jalur eksekusi MCP yang legal, B memberi
lapisan identitas/kepercayaan agent eksternal di atasnya.

---

## Aturan main (berlaku untuk semua tahap)

1. Kerjakan HANYA di worktree/branch ini. **Jangan merge/rebase/cherry-pick ke
   `develop`** — owner yang meratifikasi. Jangan menyentuh checkout utama
   `C:\Workspace\Damar` selain membaca.
2. Konstitusi repo tidak berubah: `MANAGER != AUTHORITY`, `PLAN != AUTHORITY`,
   `MODEL CLAIM != AUTHORITY`, `CHANNEL != AUTHORITY`. Authority Gate (Lane 2)
   tetap otoritas tunggal atas semua aksi. Output agent eksternal BUKAN
   authority, selamanya.
3. Commit per tahap (A0, A1, A2, …) dengan pesan jelas mengikuti gaya commit
   repo. Setiap commit harus lulus test yang relevan dengan tahapnya.
4. Test: minimal `npm run test:safety` tiap tahap; `npm test` penuh sebelum
   laporan akhir. Laporkan hasil test apa adanya (termasuk yang gagal).
5. Jurnal: buat dan perbarui `WORKER-REPORT.md` di root worktree setiap tahap —
   apa yang diubah, file apa, hasil test, keputusan yang diambil.
6. **STOP condition:** bila sebuah langkah menuntut keputusan arsitektur yang
   mengubah sertifikasi R12C — contoh: mengubah mekanisme brand/WeakSet
   komposisi Manager, mengubah hukum di `src/manager/` atau `src/authority/`,
   melemahkan perilaku fail-closed mana pun, menaikkan versi skema
   `agentfed.contract.v1` — BERHENTI di tahap itu, tulis alasannya di
   `WORKER-REPORT.md`, lanjutkan hanya tahap lain yang tidak bergantung padanya.
7. Jangan menulis token/rahasia apa pun ke file, commit, atau log.
   `DAMAR_TOKEN` hanya dibaca dari environment.

---

## Pekerjaan A — MCP eksekusi general

### Keadaan sekarang (terverifikasi)

- `src/mcp/index.js` (`attachMcp`): `POST /mcp` (JSON-RPC 2.0, di belakang
  `tokenGuard({ surface: "mcp" })`) + `GET /mcp/health`. Tanpa `DAMAR_TOKEN`,
  permukaan menjawab 503 (fail-closed — pertahankan).
- `src/mcp/mcpHandler.js` (`createMcpHandler`): protocolVersion `2024-11-05`,
  `initialize`/`ping`/`tools/list`/`tools/call` sudah benar. `tools/list`
  memaparkan 140+ tool dari `ToolRegistry.describe()` setelah
  `Authorization.disclosureFilter` (H9); tool destruktif disembunyikan kecuali
  `DAMAR_MCP_ALLOW_DESTRUCTIVE=1`.
- **Pengunci:** objek registry yang disuntikkan ke handler men-stub eksekusi:
  `execute: (id, args, ctx) => { rejectLegacyActionRoute("MCP tool"); }`
  (`src/manager/legacyBoundary.js`, error `LEGACY_ACTION_ROUTE_DISABLED`).
  Jadi `tools/call` gagal 100% hari ini, by design, menunggu adapter ini.
- Bridge stdio resmi: `scripts/mcp-stdio.js` (`npm run mcp:stdio`) meneruskan
  JSON-RPC ke `POST $DAMAR_MCP_URL` dengan header Bearer `$DAMAR_TOKEN`.
- Peran permukaan eksternal diklem `clampExternalRole()`; default peran MCP =
  `user` (`DAMAR_MCP_ROLE`).
- `CHANNEL_TYPES` (`src/manager/schema.js`): `console, cli, telegram, whatsapp,
  companion, voice` — belum ada channel MCP/worker. Adapter terdaftar di
  `src/manager/channels.js` (`CHANNEL_ADAPTERS`); kontrak normalisasi di
  `src/manager/channelAdapter.js` (adapter hanya menormalisasi + me-render,
  tidak pernah mengotorisasi). Klasifikasi `action_proposal`/`action` wajib
  Lane 2 → Lane 3; sisanya selesai tanpa fabric aksi.
- Facade Manager produksi: `{ handle, cancel, isCanonicalManagerRequest,
  isCanonicalManagerResult }`, hanya lahir dari komposisi tepercaya
  (`createDamarManagerIngressDomain` di `src/manager/bootstrap.js`, dirakit
  `src/integration/canonicalRuntimeComposition.js` dengan flag
  `enableManagerIngress`). Entry `src/manager/index.js` hanya mengekspor
  kosakata inert + `createDamarManager`.
- Test yang sudah ada: `tests/safety/mcp.test.js`, `tests/safety/mcpClient.test.js`.

### Syarat mutlak owner — MCP GENERAL/STANDAR

Server ini harus bisa dipakai **client MCP apa pun** (Muse, Codex, Cursor,
Claude Desktop, inspector, curl mentah), bukan dibuat khusus untuk satu client:

- JSON-RPC 2.0 standar; transport Streamable HTTP `POST /mcp` yang sudah ada
  + bridge stdio `scripts/mcp-stdio.js` tetap berfungsi.
- Auth = header `Authorization: Bearer <DAMAR_TOKEN>` standar. Tidak ada
  skema auth proprietary.
- DILARANG: memeriksa User-Agent/nama client, header khusus client tertentu,
  perilaku berbeda per client, atau asumsi format di luar spesifikasi MCP.
- Pembuktian: smoke test wajib lulus dari (1) HTTP mentah (curl/PowerShell
  `Invoke-RestMethod`) dan (2) bridge stdio — dua jalur client-agnostic.

### Tahap A

- **A0 — Baseline.** Jalankan daemon dari worktree (`npm start`, `DAMAR_TOKEN`
  dummy lokal via env saja), verifikasi `GET /mcp/health` dan `tools/list`
  dari localhost; jalankan `tests/safety/mcp.test.js` +
  `mcpClient.test.js` — harus hijau sebelum perubahan apa pun. Catat di
  `WORKER-REPORT.md`.
- **A1 — Channel worker.** Tambah `MCP: "mcp"` ke `CHANNEL_TYPES`
  (`src/manager/schema.js`) + adapter normalisasi di `CHANNEL_ADAPTERS`
  (`src/manager/channels.js`) mengikuti kontrak `channelAdapter.js`. Peer
  identity principal MCP di-mint dari konteks token (`req.mcpExec` / hasil
  `tokenGuard`), BUKAN dari payload klien.
- **A2 — Trusted Manager adapter (inti).** Di `src/mcp/index.js`, ganti stub
  `execute` dengan adapter tepercaya: peroleh facade Manager dari komposisi
  kanonik (pola `createDamarManagerIngressDomain`), bentuk ManagerRequest
  ber-brand dari `(toolId, args, ctx)`, panggil `handle()`, proyeksikan
  ManagerResult menjadi hasil MCP (`content`/`isError`). Pertahankan:
  disclosure filter H9, destruktif tersembunyi secara default, peran diklem.
  Adapter adalah bagian komposisi tepercaya — bukan pemanggil longgar dari
  route Express.
- **A3 — Policy Lane 2 untuk principal MCP.** Principal permukaan `mcp`
  (peran `user`): allowlist sempit — discovery/read-only + tool intent A4 —
  DENY untuk semua di luar allowlist. Audit (Lane 4) mencatat principal `mcp`
  + sessionId. Tidak ada jalur dari `tools/call` ke `ToolRegistry.execute`
  yang melewati keputusan Lane 2.
- **A4 — Tool intent tingkat Manager.** Ekspos tool proyeksi Manager berikut
  (terpisah dari registry mentah):
  - `damar.submit_intent` — teks tugas + klasifikasi `action_proposal` →
    ManagerRequest; kembalikan task id.
  - `damar.get_task_status` — status/outcome ManagerResult dari task id.
  - `damar.cancel_task` — memanggil `cancel` pada facade Manager.
  - `damar.list_capabilities` — subset disclosure untuk principal worker.
  Pemetaan task id ↔ lifecycle hasil Manager disimpan di adapter (in-memory
  cukup untuk tahap ini; catat keterbatasannya di laporan).
- **A5 — Test A.** Perluas `tests/safety/mcp.test.js` (atau file test baru
  se gaya): (1) `tools/call` tool allowlist → sukses lewat Lane 2/3/4;
  (2) tool di luar allowlist → DENY; (3) tidak ada jalur eksekusi tanpa
  keputusan Lane 2; (4) destruktif tetap tersembunyi default; (5) tanpa token
  → 503; (6) smoke dua jalur client-agnostic (HTTP mentah + stdio bridge)
  untuk `initialize` + `tools/list` + satu `damar.submit_intent`.

---

## Pekerjaan B — Selesaikan wiring `src/agentfed/`

### Keadaan sekarang (terverifikasi dari kode di Aether)

Lapisan federasi agent eksternal SUDAH JADI sebagai library, tapi mati di
tempat — tidak tersambung ke transport maupun Manager:

- `src/agentfed/index.js` — `makeAgentFed(acc)` mengembalikan
  `{ lifecycle, messages, quarantine, reliability, egress }`. `acc` adalah
  store dengan `getKv`/`putKv` (store agentfed memakai prefix kv `agentfed:`,
  lihat `src/agentfed/store.js`).
- `src/agentfed/agent.js` — STATES: `DISCOVERED → QUARANTINED → INSPECTED →
  VALIDATED → ENABLED → REVOKED`; transisi ilegal melempar error.
- `src/agentfed/lifecycle.js` — `register(agentId, contract)`,
  `transition(agentId, toState, { ownerApproval })`, `revoke(agentId)`,
  `getAgent(agentId)`. Transisi ke `ENABLED` TANPA `ownerApproval: true`
  ditolak ("Agent self-enable refused"). Identitas REVOKED tidak bisa dipakai
  ulang.
- `src/agentfed/laws.js` — hukum yang wajib ditegakkan wiring (jangan diubah):
  `EXTERNAL_AGENT_OUTPUT_IS_NOT_AUTHORITY`,
  `AGENT_ASSERTIONS_ARE_T5_UNTIL_CORROBORATED`, `AGENT_CANNOT_SELF_ENABLE`,
  `AGENT_SCOPE_REQUIRES_OWNER_GRANT`,
  `AGENT_CANNOT_MUTATE_OWN_TRUST/AUTHORITY/CAPABILITIES/BUDGET`,
  `EGRESS_REDACTS_NON_OWNER_DESIGNATED_DATA`, `FLOOD_IS_THROTTLED_NOT_ERRORED`.
- `src/agentfed/bounds.js` — skema `agentfed.v1`, `agentfed.contract.v1`,
  `agentfed.message.v1`; batas: 32 agent ENABLED, 8 sesi konkuren, payload
  maks 64 KB, 1000 pesan/agent/jam, scope TTL 90 hari.
- `src/agentfed/message.js` — `receive(agentId, payload)`: menolak agent
  non-ENABLED, menegakkan flood limit + `MAX_PAYLOAD_BYTES` +
  `assertNotSelfElevation` (payload tidak boleh memuat kunci `trust`,
  `authority`, `capabilities`, `budget`, `nodeMembership`). Hasil selalu
  `{ tier: "T5", corroborated: false }`.
- `src/agentfed/quarantine.js` — `addAssertion` / `corroborate` (assertion
  agent masuk karantina, bukan memory/goal aktif).
- `src/agentfed/reliability.js` — `recordSuccess` / `recordFailure` / `getStats`.
- `src/agentfed/egress.js` — `send(agentId, payload, { ownerAllowList })` /
  `redactEgress`: kunci `internalState`, `ownerToken`, `authToken`, `secret`
  selalu di-redact kecuali owner meng-allowlist eksplisit.
- **Satu-satunya instansiasi:** `makeOpenWorldOps` di
  `src/cognition/openworld/index.js` memanggil `makeAgentFed(acc)` — tetapi
  `makeOpenWorldOps` sendiri TIDAK dipanggil komposisi daemon mana pun (grep
  `makeOpenWorldOps` di `src/` hanya menemukan definisinya). Tidak ada docs
  yang menyebut agentfed. Tidak ada test khusus agentfed (yang dekat:
  `tests/wave6/l4/federation.test.js` untuk `src/federation/`).

### Tahap B

- **B1 — Komposisi.** Instansiasikan `makeAgentFed(acc)` dalam komposisi
  runtime daemon, dengan `acc` yang sama seperti subsistem cognition lain
  (ikuti pola komposisi di `src/integration/` dan
  `src/services/aiRuntimeService.js`). Handle agentfed harus bisa dijangkau
  adapter MCP (A2) dan surface owner (B2) — tanpa menciptakan authority baru
  dan tanpa mengubah `makeOpenWorldOps`.
- **B2 — Surface owner untuk lifecycle.** Endpoint Console API
  (`/api/v1/console/...`, di belakang `tokenGuard` peran `superadmin`,
  mengikuti pola route console yang ada): register agent dengan kontrak
  `agentfed.contract.v1`, transisi `INSPECTED`/`VALIDATED`/`ENABLED`
  (ENABLED selalu meneruskan `ownerApproval: true` dari jalur owner ini —
  tidak ada jalur lain yang boleh mengesetnya), `revoke`, list/get agent,
  reliability stats. Perhatikan pola route console yang sudah dipasangi
  `rejectLegacyActionMiddleware` — endpoint BARU ini bukan route legacy,
  tapi bila pola repo menuntut keputusan disposition untuk route aksi baru,
  dan itu menyentuh sertifikasi → STOP condition (lihat aturan main #6).
- **B3 — Binding sesi MCP ke identitas agent.** Sesi `POST /mcp` boleh membawa
  identitas agent (pilih SATU mekanisme: header `X-Damar-Agent-Id` atau field
  identitas pada params `initialize` — dokumentasikan pilihan + alasannya di
  `WORKER-REPORT.md`). Adapter A2 wajib: memeriksa
  `lifecycle.getAgent(agentId).state === ENABLED` sebelum menerima
  `tools/call` dari agent itu; meneruskan pesan lewat `messages.receive`
  (hasil tetap tier T5); mencatat `reliability.recordSuccess/recordFailure`
  per hasil call; mengarahkan assertion agent ke `quarantine.addAssertion`.
  Sesi MCP tanpa identitas agent tetap berperilaku seperti Pekerjaan A
  (principal token biasa) — binding agent adalah lapisan tambahan, bukan
  syarat untuk client MCP umum.
- **B4 — Egress.** Semua payload yang keluar menuju agent eksternal (hasil
  tool, status task) wajib lewat `egress.send` dengan `ownerAllowList`
  eksplisit (default: kosong).
- **B5 — Scope dari owner grant.** Tegakkan `AGENT_SCOPE_REQUIRES_OWNER_GRANT`:
  kontrak agent memuat scope kapabilitas yang di-grant owner (subset dari
  allowlist A3) + masa berlaku ≤ `AGENT_SCOPE_TTL_MS` (90 hari). Adapter
  menolak capability di luar scope kontrak walau allowlist umum mengizinkan.
  Bila field kontrak perlu ditambah, tambahkan validasi TANPA menaikkan versi
  `agentfed.contract.v1`; bila ternyata harus bump versi → STOP condition.
- **B6 — Test B.** Test baru (mis. `tests/safety/agentfed-wiring.test.js`,
  mengikuti gaya test repo): (1) lifecycle penuh hanya bisa lewat surface
  owner; self-enable ditolak; (2) agent non-ENABLED ditolak di MCP;
  (3) agent REVOKED tidak bisa register ulang; (4) egress me-redact
  `ownerToken`/`secret`; (5) payload berkunci `trust`/`authority` ditolak;
  (6) capability di luar scope kontrak ditolak walau masuk allowlist;
  (7) flood limit bekerja.

---

## Urutan kerja & deliverables

Urutan: A0 → A1 → A2 → A3 → A4 → A5 → B1 → B2 → B3 → B4 → B5 → B6 →
`npm run test:safety` penuh → (bila hijau) `npm test`.

Deliverables:

- Commit per tahap di `feat/mcp-worker-bridge`, TIDAK di-merge ke `develop`.
- `WORKER-REPORT.md` di root worktree: jurnal per tahap + laporan akhir
  (yang selesai, hash commit, hasil test, yang tertunda/STOP dan alasannya,
  keputusan yang diserahkan ke owner).
- MCP hasil akhir harus lulus uji generalitas A5 butir (6): client MCP mana
  pun bisa connect, discovery, dan memanggil tool intent — tanpa perlakuan
  khusus per client.
