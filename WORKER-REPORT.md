# Laporan Teknis MCP Worker

Branch `feat/mcp-worker-bridge`, worktree `C:\Workspace\Damar-mcp-worker`.

## A0 — Baseline (2026-11-23 20:17 WIB)

Tidak ada kode yang diubah. `MCP-WORKER-TASK.md` ditambahkan sebagai dokumen tugas. Dependensi worktree belum terpasang: percobaan awal `npm start` gagal karena `express` tidak ada. Setelah `npm ci --ignore-scripts`, percobaan kedua gagal karena binding native `sqlite3` belum dibangun. `npm rebuild sqlite3` memperbaikinya. Daemon kemudian berhasil start dengan token dummy lokal hanya dari environment dan port 43117. `GET /mcp/health` menjawab OK dengan 10 tool, dan JSON-RPC `tools/list` mengembalikan 10 tool untuk peran default `user`. Daemon dihentikan setelah pemeriksaan.

Tes MCP khusus: 19 lulus, 0 gagal. `npm run test:safety`: 535 lulus, 0 gagal, 6 skip dari 541.

Temuan arsitektur awal untuk tahap A2: Manager produksi memanggil autentikasi kanonik Lane 2, yang saat ini menerima hanya bukti owner/admin bertanda tangan. Token MCP tidak dapat membentuk principal Manager melalui seam tersebut. Dampak STOP condition akan dinilai pada A2.

## A1 — Channel worker (2026-11-23 20:19 WIB)

`src/manager/schema.js` dan `src/manager/channels.js` mendapat kanal/adapter `mcp` yang memakai normalisasi serta rendering bersama tanpa hak otorisasi. Di `src/mcp/index.js`, `tokenGuard` berjalan sebelum pembentukan `req.mcpExec`; principal `mcp`, role, source, dan sessionId berasal dari identitas autentikasi token. Tidak ada field principal yang diterima dari payload MCP. `npm run test:safety`: 535 lulus, 0 gagal, 6 skip dari 541. `graphify update .` dijalankan setelah edit kode.

## A2 — STOP (2026-11-23 20:21 WIB)

Tidak ada kode A2 yang diubah. `createDamarManager()` memang memiliki `handle`, tetapi `handle()` membentuk request lalu memanggil `capturedLane2.authenticate(evidence)`. Former Manager hanya menerima `authProof.kind` `owner-proof` atau `admin-proof`; tanpa bukti tersebut, autentikasi gagal tertutup dengan `AUTHENTICATION_REQUIRED`. Verifier produksi di `ownerTrustComposition.js` juga hanya menerima kedua kind itu dan memerlukan tanda tangan sah. `tokenGuard` HTTP mengeluarkan `req.authIdentity`, tetapi identitas itu tidak diterima sebagai bukti oleh jalur autentikasi kanonik. Menghubungkannya secara legal membutuhkan keputusan tentang autentikasi principal MCP dalam Manager/Authority yang tersertifikasi R12C. Mengubah verifier, former, atau memintasnya dengan registry langsung akan melanggar STOP condition/konstitusi brief.

Stub `LEGACY_ACTION_ROUTE_DISABLED` pada `tools/call` dipertahankan. A3–A5 bergantung pada adapter A2. B1 memerlukan handle agentfed yang dapat dijangkau adapter A2 dan surface owner sambil memakai store ACC yang sama; B2–B6 memerlukan komposisi tersebut. Tidak ada jalur implementasi tersisa yang memenuhi kontrak tugas tanpa keputusan owner. Pilihan keputusan yang diserahkan: cara token MCP yang sudah tervalidasi memperoleh sesi autentikasi kanonik Lane 2 sebagai principal MCP berhak minimum, serta batas eksposur handle agentfed pada komposisi daemon. Tidak ada perubahan sertifikasi yang dibuat di worktree ini.

## A1 — Perbaikan tes daftar kanal (2026-11-23 20:32 WIB)

Full suite pertama menemukan tes `tests/manager/channelAdapters.test.js` yang mengunci daftar enam kanal lama. Ekspektasi ditambah `CHANNEL_TYPES.MCP`; tes tersebut kini lulus 2/2. Output full suite pertama difilter hanya ke 12 baris terakhir, sehingga angka totalnya tidak tersedia; hasilnya tetap dicatat sebagai gagal. Perbaikan ini tidak membuka jalur aksi dan tidak mengubah keputusan STOP A2.

## Laporan akhir (2026-11-23 20:46 WIB)

Tahap selesai: A0 dan A1, termasuk perbaikan tes daftar kanal. Tahap A2 dihentikan sesuai STOP condition; A3–A5 dan B1–B6 belum dikerjakan karena bergantung pada jalur autentikasi Manager kanonik untuk principal MCP. Hash commit tahap terakhir sebelum laporan akhir: `39f5c5d7`; hash commit catatan STOP: `74c61ece`. Hash commit laporan akhir dibaca dari HEAD setelah commit laporan ini.

Hasil terakhir: `npm run test:safety` 535 lulus, 0 gagal, 6 skip dari 541; `npm test` 4609 lulus, 0 gagal, 9 skip dari 4618. Tes full pertama sempat gagal pada ekspektasi daftar kanal; diperbaiki dan diuji ulang hingga hijau. `graphify update . --no-cluster` berhasil memperbarui graf AST (42050 node, 89087 edge). Perubahan provenance plugin dari tes dipulihkan; log sesi eksekusi tidak di-commit.

Diserahkan ke owner: commit tahap, kanal/adapter MCP yang mengambil konteks dari token guard, laporan dan brief, serta keputusan arsitektur yang diperlukan untuk autentikasi principal MCP berhak minimum di Lane 2 tanpa melemahkan verifikasi owner/admin. `tools/call` masih memakai stub `LEGACY_ACTION_ROUTE_DISABLED`; smoke eksekusi A5 tidak dapat dipenuhi sebelum keputusan tersebut. B1–B6 menunggu komposisi handle agentfed yang terhubung ke store ACC yang sama dan adapter MCP yang sah.


## A2 Lanjutan — Rancangan Jalur Grant + Prototipe Terisolasi (2026-11-23 22:2x WIB)

Owner memutuskan (22:08 WIB) jalur auth MCP Lane 2 dilanjutkan. Sesi ini
meneliti ulang seluruh seam yang tersedia dan menyimpulkan: satu-satunya
yang hilang adalah KIND BUKTI BARU di verifier autentikasi kanonik.
Bukti penunjang (terverifikasi dari kode sesi ini):

- `selfSignOwnerProof()` ada tetapi cakupannya tertulis "canonical HTTP
  surface only" untuk caller token-authenticated di console, dan ia
  meng-mint principal OWNER — meluaskannya ke MCP melanggar hak minimum.
- Grant ACC (`evaluate.js`/`delegation.js`) adalah lapisan otorisasi atas
  identitas yang sudah terautentikasi; ia tidak mengautentikasi.
- Binding kanal tidak menjadi bukti yang diterima `authenticate` Manager.

Deliverable sesi ini (BUKAN perubahan produksi):
- `docs/mcp-lane2-owner-grant-design.md` — rancangan lengkap: bukti baru
  `grant-proof`, grant owner bertanda tangan di store ACC (subject terikat
  identitas token + agentId opsional, scope subset allowlist intent,
  TTL <= 90 hari, kunci worker untuk PoP), daftar perubahan produksi
  minimum (former whitelist, cabang verifier, adapter, surface Console),
  dan alasan mengapa ini tetap keputusan arsitektur R12C milik owner.
- `src/mcp/ownerGrant.js` — prototipe TERISOLASI (tidak diimpor komposisi
  produksi): penerbitan/verifikasi grant Ed25519 + gate PoP nonce satu
  kali pakai sebagai inti policy A3.
- `tests/safety/mcpOwnerGrant.test.js` — 13 tes, semua lulus (termasuk
  negatif: tanpa grant, tanda tangan palsu, payload diubah, expired,
  eskalasi scope, PoP kunci salah, replay nonce). Tes MCP lama tetap
  19/19. `tools/call` tetap fail-closed; A3–A5 dan B1–B6 tetap menunggu
  ratifikasi perubahan verifier pada rancangan, BUKAN menunggu prototipe.
