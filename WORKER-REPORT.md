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
