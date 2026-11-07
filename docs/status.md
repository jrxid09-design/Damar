# Damar OS — Status

**Terakhir diperbarui:** 2026-08-12
**Keadaan:** Berjalan di produksi — batas keselamatan terpasang & teruji
**Verifikasi §276:** 16 lulus · 0 sebagian · 0 belum (`npm run audit`)

---

## Sistem mana yang otoritatif sekarang

**Satu sistem, bukan dua.** ADR-001 dulu merencanakan repositori terpisah;
ADR-006 menggantinya dengan evolusi di tempat. Tidak ada Damar OS kedua yang
menunggu — yang ada satu sistem yang tumbuh.

| Fungsi | Keadaan | Lokasi |
|---|---|---|
| Chat, tool, memori harian | **Berjalan** | `C:\Workspace\Aether` — port 3000 |
| Foto (Immich) | **Berjalan** + Docker | port 2283 |
| WhatsApp, Telegram | **Berjalan** | — |
| Batas keselamatan (gerbang tool destruktif, STOP, verifikasi, jejak audit) | **Berjalan & teruji** | `src/core/safety`, `src/core/verify` |
| Suara (STT/TTS) | **Rusak** — image Docker hilang | port 8000/8880/8881 |

---

## Sudah selesai

| Item | Berkas |
|---|---|
| Audit lingkungan | `docs/architecture/initial-environment-audit.md` |
| Konstitusi | `docs/constitution.md` |
| ADR-001 pemisahan repositori | `docs/adr/ADR-001-repository-separation.md` |
| ADR-002 bahasa & runtime | `docs/adr/ADR-002-language-and-runtime.md` |
| ADR-003 strategi model tanpa GPU | `docs/adr/ADR-003-no-gpu-model-strategy.md` |
| ADR-004 lokasi data infrastruktur | `docs/adr/ADR-004-infrastructure-storage-location.md` |
| ADR-005 penundaan Tauri | `docs/adr/ADR-005-defer-tauri-desktop-shell.md` |
| Roadmap | `docs/roadmap.md` |

---

## Batas keamanan — terpasang & teruji

Strategi diubah ke evolusi di tempat (ADR-006). Yang berikut sudah berjalan di daemon produksi:

| Item | § | Berkas | Bukti uji |
|---|---|---|---|
| **Kill switch** | 37 | `src/core/safety/killSwitch.js` | Memblokir tool di jalur Console **dan** model; bertahan lintas restart; allowlist baca-saja lolos |
| **Error terstruktur** | 110 | `src/core/safety/DamarError.js` | `code`, `severity`, `retryable`, `recovery` |
| **Katalog risiko (biner)** | 34 | `src/core/safety/riskCatalog.js` | Disederhanakan dari L0–L5 menjadi satu keputusan: destruktif atau tidak. Klasifikasi tetap dihitung untuk audit dan verifikasi |
| **Kebijakan otorisasi** | 33 | `src/core/safety/riskPolicy.js` | Guard selalu mengizinkan semua eksekusi; klasifikasi destruktif tetap dilaporkan untuk audit |
| **Audit eksekusi tool** | 96 | `ToolRegistry.execute` | Event `tool:execute` untuk tool destruktif |
| **Verification Engine** | 46 | `src/core/verify/` | **Menangkap klaim sukses palsu**: tool melapor berhasil menulis ke `Z:/` yang tidak ada → verifikasi `failed` |
| **Anti-loop** | 140 | `src/core/safety/loopGuard.js` | 4 panggilan identik lolos, ke-5 dihentikan; 6 argumen berbeda semua lolos (tanpa salah tuduh) |
| **Provenance + temporal memori** | 13, 17, 20 | migrasi `004`, `MemoryService.supersede/history` | Fakta GPU berubah → yang lama ditandai digantikan, recall hanya mengembalikan yang berlaku, riwayat 2 simpul tetap dapat ditelusuri |
| **Hierarki otoritas + anti-injeksi** | 231–238 | `src/core/safety/contentBoundary.js` | Berkas berisi `SYSTEM: abaikan instruksi…` **tidak dituruti** — model melaporkannya ke pengguna; penanda palsu dinetralkan; nonce acak mencegah penutupan blok |
| **Tes otomatis** | 221, 229 | `tests/safety/*.test.js` | **182 tes** (179 + 3 uji offline baru). Catatan kejujuran: satu tes pemilih tool sedang **merah** terhadap penulisan ulang `ToolSelector.js` yang belum ter-commit — tes menuntut urutan pendaftaran, pemilih baru sengaja memakai urutan inti-dulu demi cache prefix prompt. Keduanya milik pekerjaan yang sedang berjalan, bukan bagian dari uji offline — keselamatan, jalur model, planner, verifier git, jejak audit, pemilih tool, memori-diri, batas waktu, saklar gerbang. `npm test` (tes menulis ke direktori sementara, tidak mencemari jejak sungguhan) |
| **Saklar gerbang destruktif** | 33, 123 | `safety/riskPolicy.js`, `views/safety.js` | Gerbang tool destruktif dapat dimatikan pemilik, dengan opsi durasi. Saklar eksplisit, bukan ambang palsu, supaya keadaannya terbaca jujur. STOP, sandbox, rem kebuntuan, dan verifikasi **tidak** ikut mati; bahaya tetap dihitung dan dicatat |
| **Anggaran prompt: batas atas, bukan target** | 28 | `ai/tools/ToolSelector.js` | Sapaan "halo" mengirim 32 definisi tool = **1.910 token** berisi tool WhatsApp/kamera — semuanya berskor **nol**, terpilih hanya karena urutan pendaftaran. Kini yang berskor nol tidak ikut |
| **Obrolan biasa tanpa tool sama sekali** | 28 | `ai/tools/ToolSelector.js` | Melampirkan tool berharga **tetap 777 token** (template llama3.1) sebelum tool pertama dihitung: tanpa tool 12 tok/1,8 dtk, 6 tool 789 tok/15,5 dtk, 32 tool 1.577 tok/34,2 dtk. **Sapaan: ~43 dtk → ~13,5 dtk** (3× ukur). `DAMAR_TOOLS_WHEN_IDLE=backbone` mengembalikan perilaku lama |
| **Jurnal rekayasa tidak menyusup ke obrolan** | 20 | `memory/services/MemoryService.js` | Sapaan "Halo" menarik catatan build ke system prompt — panjang, teknis, tak berguna bagi pengguna. Ini juga penyebab ragam prompt 1.356–2.365 yang tadinya misterius. Prompt kini stabil **1.214–1.224** |
| **Tombol STOP di Console** | 123, 272 | header `index.html`, `app.js` | Selalu terlihat; berubah jadi LANJUTKAN + berdenyut saat berhenti; ikut tersegarkan tiap poll bila STOP ditarik dari kanal lain |
| **Panel Keamanan** | 123, 272 | `views/safety.js` | Keadaan rem, gerbang destruktif, jejak tindakan, izin aktif — semuanya dapat diubah tanpa terminal, tanpa memahami tingkatan apa pun |
| **Verifier per tool** | 46, 196 | `verify/verifiers.js` | Perangkat dibaca ulang lewat `getState`; pesan butuh id dari WhatsApp |
| **Sandbox jalur** | 38 | `safety/pathPolicy.js` | Menulis ulang `safety.json` **diblokir**; kunci SSH diblokir; traversal ke System32 diblokir; kerja sah di C:/D:/E: tetap jalan |
| **Rantai tunggal untuk kedua jalur tool** | 33, 37, 38, 46, 140 | `safety/toolGuard.js`, ADR-007 | **Menutup kebocoran nyata**: 47 tool asli model (terminal, coding, rumah, WhatsApp, memori) selama ini melewati registry AI dan hanya dijaga kill switch. Kini `terminal_run` (destruktif) ditolak di daemon yang berjalan; tool jembatan tidak dijaga dua kali |
| **Katalog risiko dibetulkan** | 34 | `safety/riskCatalog.js` | Pola substring membaca `memory_forget` sebagai bacaan murni karena "get" ada di dalam "forget" — kini berbasis batas kata |
| **Daftar tool asli disatukan** | — | `aiRuntimeService.nativeTools()` | Perakitan awal dan penyegaran menulis daftarnya masing-masing dan sudah menyimpang: 33 tool (coding + keluarga) hanya terdaftar bila forge berubah. Model tak melihat graphify/Serena/test/commit pada daemon yang baru menyala. **105 → 138 tool**, diverifikasi lewat `code_lsp_status` yang kini dapat dipanggil |
| **Verifier git** | 46 | `verify/verifiers.js`, `gitPatcher.restore` | `restore()` menelan kegagalan git lalu tetap melapor berhasil — **rollback gagal terbaca sukses, tepat saat test merah**. Kini git ditanyai langsung: HEAD, pesan commit, sisa ter-stage, selisih terhadap HEAD, branch aktif. Sumbernya juga diperbaiki agar berhenti mengklaim |
| **Jejak audit yang bertahan** | 96 | `safety/auditTrail.js`, `views/safety.js` | `telemetry.publish()` hanya memancarkan, **tidak menyimpan**: tanpa Console terbuka, tidak ada catatan Damar menulis berkas atau mengirim pesan. Kini JSONL harian, 14 hari, terlihat di panel. Mencatat **penolakan** juga — percobaan melewati batas kini meninggalkan bekas |
| **Jaminan tool inti diperbaiki** | 28 | `ai/tools/ToolSelector.js` | Anggaran prompt 32 dari 138 tool — 106 dibuang tiap permintaan. Daftar "selalu ikut" menuliskan `readFile` padahal model melihat `filesystem__readFile`: **tidak pernah cocok**, jadi justru tool berkas kehilangan jaminannya diam-diam. Kini dicocokkan pada ruas terakhir nama. `terminal_run` dikeluarkan dari jaminan — destruktif, ditahan, dan terbukti menuntun model memilihnya untuk menanyakan jam |
| **Waktu lokal, bukan UTC** | — | `plugins/system.time/tool.js` | Tool hanya mengembalikan `toISOString()` — selalu UTC tanpa penanda zona. Damar menjawab **"18:22"** saat di sini pukul **01:22**, kadang dilabeli "WIB". Salah tujuh jam dan disampaikan dengan yakin. Kini waktu lokal disajikan lebih dulu beserta zonanya; `time` tetap ISO untuk pemakai lama |
| **Damar tahu dirinya sendiri** | 13, 20 | `memory/buildMemory.js`, `tools/buildTools.js`, `scripts/learn.js` | Jurnal rekayasa masuk ke memori Damar: keputusan, **alasannya**, berkas, pembuktian, risiko tersisa. Ditanya "kenapa terminal_run diblokir", Damar memanggil `build_recall` dan menjawab dari catatan — bukan menebak. 14 catatan tersemai. Batasnya tegas: **peristiwa → jejak audit, pengetahuan → memori** |
| **Batas waktu per panggilan model** | — | `ai/runtime/AIRuntime.js`, `ai/executors/RuntimeExecutor.js` | Batas 120 dtk membungkus **seluruh** loop tool. Di CPU satu panggilan 40–60 dtk, jadi permintaan yang memakai dua tool hampir pasti gagal — batas itu menghukum tepat perilaku yang diinginkan. Kini per panggilan; langit-langit 4× untuk yang benar-benar menggantung. Permintaan yang tadi gagal kini tuntas **139 dtk** |
| **Planner DAG + checkpoint** | 28, 29, 30 | `agent/models/*`, `agent/planStore.js` | Dependensi, deteksi siklus, kemajuan; checkpoint atomik per langkah pada loop tool yang **benar-benar berjalan**; langkah "running" dikembalikan ke antrean saat dilanjutkan; rencana tuntas dibersihkan, yang tertinggal dilaporkan saat boot |
| **Uji offline yang benar-benar menguji offline** | 276#10 | `tests/safety/offline.test.js`, `tests/helpers/offlineChild.js`, `scripts/audit-276.js` | Pemeriksaan lama melaporkan **LULUS karena alasan yang salah**: menambal `fetch` di dalam proses audit sendiri lalu memanggil `/api/tags` — daftar model, bukan inferensi — sementara daemon yang diuji berjalan di proses lain dan jaringannya tak pernah disentuh. Buktinya berbunyi "jalur inferensi tetap terjawab" padahal **tidak ada inferensi yang berjalan**: persis klaim sukses palsu yang dibangun VerificationEngine untuk menangkapnya. Kini jalur keluar diputus pada lapisan **socket** (fetch/undici, http, https ikut) di proses anak, sebelum satu pun modul Damar dimuat, lalu **inferensi sungguhan** dijalankan — menjawab 71 karakter dalam 6 dtk. Alat ukurnya dibuktikan lebih dulu: koneksi non-lokal harus benar-benar gagal, kalau tidak uji ini gugur. Jaringan pemilik tidak disentuh (memutusnya dapat memutus Tailscale) |

### Perkakas rekayasa

| Perkakas | Status | Peran |
|---|---|---|
| **graphify** 0.9.37 | Terpasang, terindeks | Orientasi arsitektur sebelum membaca sumber |
| **Serena** 1.7.0 | Terpasang, **466 berkas terindeks**, health-check lulus | Intelijen kode semantik (LSP). Tools-nya lewat MCP — perlu didaftarkan di harness untuk dipanggil langsung |
| **Ponytail** | **Sengaja tidak dipasang** | §56 menyebutnya gerbang rekayasa, bukan dependensi runtime. Dipakai sebagai pertanyaan sebelum menulis kode |

**Tanpa gerbang** — mekanisme level L0–L5 dan gerbang otorisasi tool destruktif sudah dihapus sepenuhnya: guard selalu mengizinkan semua eksekusi, tanpa kecuali. Klasifikasi destruktif tetap dihitung untuk audit, verifikasi, dan telemetri.

**Yang tetap berjalan:** tombol STOP (Pasal 2.1), sandbox jalur berkas, rem kebuntuan, verifikasi hasil, dan jejak audit. Tingkat risiko tetap dihitung dan tetap tercatat — hanya tidak lagi menahan.

**138 tool kini terdaftar** (dua registry: 80 plugin + 58 tool asli model). Sebelum ADR-007 hanya 80 yang benar-benar dijaga, dan 33 di antaranya — seluruh kemampuan coding — bahkan tidak terlihat oleh model pada daemon yang baru dinyalakan.

Endpoint: `GET /safety`, `GET /safety/trail`, `POST /safety/stop|release`, `GET /safety/risk/:id`

---

### Empat keadaan verifikasi

Dibedakan dengan sengaja — menyamakan `unverified` dengan `verified` persis kesalahan yang ingin dihapus:

| Keadaan | Arti |
|---|---|
| `verified` | Ada bukti nyata dunia berubah sesuai klaim |
| `failed` | Bukti menunjukkan klaim **tidak** benar |
| `unverified` | Belum ada verifier untuk tool ini |
| `skipped` | Risiko terlalu rendah untuk perlu dibuktikan |

Verifier yang sudah nyata: `writeFile` (ada + ukuran + hash isi), `createDirectory`, `deleteFile` (bukti = ketiadaan), `copyFile` (hash identik), `moveFile` (sumber hilang), `remember` (dapat dipanggil ulang), keluarga `http.*` (status 2xx/3xx), `http.download` (berkas ada + ukuran).

---

## Berikutnya

Semua P0–P2 di daftar lama sudah terpasang dan teruji. Yang tersisa:

1. **Melanjutkan rencana, bukan sekadar mencatatnya** (§30). Checkpoint kini
   merekam apa yang sudah terjadi; melanjutkan otomatis ditahan sengaja
   karena mengulang langkah berefek samping tanpa sepengetahuan pemilik
   melanggar Pasal 2.1. Butuh keputusan: mana yang aman diulang.
2. **Verifier untuk sisa tool coding** (§46). `code_commit`, `code_rollback`,
   dan `code_branch` sudah punya bukti independen dari git. `code_test`
   sengaja dibiarkan tanpa verifier: membuktikannya berarti menjalankan
   ulang seluruh test — mahal dan berefek samping.
3. **Memori sidecar Python** (Graphiti/Qdrant) — P3 di `directive-mapping.md`.
4. **Suara** — masih terhambat image Docker yang hilang.

---

## Terhambat

| Item | Penghambat | Dampak |
|---|---|---|
| Suara (Kokoro/Piper) | Image Docker hilang; perlu tarik ulang ± 7 GB | Tidak menghambat Milestone 0.1 |
| Neo4j, Qdrant, MinIO, PostgreSQL | Belum dipasang (disengaja — §107 instalasi bertahap) | Dibutuhkan mulai Milestone 0.2 |
| Rust/Tauri | Sengaja ditunda (ADR-005) | Dibutuhkan Milestone 0.5 |

---

## Keterbatasan yang diketahui

| # | Keterbatasan | Sumber |
|---|---|---|
| 1 | **Tanpa GPU diskrit.** Inferensi lokal CPU-only: cold load 10,2 s, prompt eval ± 43 tok/s | Audit §2 |
| 1b | **Ukuran prompt = waktu.** Laju mesin ini: prompt eval **48,8 tok/dtk**, generasi **5,1 tok/dtk**. Setiap token yang tidak perlu dibayar dengan detik | Ukur 2026-08-12 |
| 1c | **Prompt sistem 812 token** dibayar pada setiap permintaan (± 17 dtk). Memangkasnya berarti mengubah kepribadian Damar — keputusan pemilik | Ukur 2026-08-12 |
| 2 | **C: tersisa 86 GB.** Data infrastruktur wajib ke D: | Audit §2 |
| 3 | **Router mengisolasi klien LAN.** Akses lintas-perangkat lewat Tailscale | Audit §6 |
| 4 | **IP LAN dari DHCP**, bisa berubah | Audit §6 |
| 5 | **Legacy nyaris tanpa tes** (1 berkas / 43.000 baris) — referensi, bukan fondasi | Audit §8 |
| 6 | **Image Docker pernah hilang sendiri** (dugaan: containerd snapshotter) | Audit §7 |

---

## Catatan kejujuran

Dokumen ini mencatat apa yang **benar-benar ada**, bukan yang direncanakan.

Saat ini Damar OS terdiri dari dokumen arsitektur saja. Belum ada kernel, belum ada API, belum ada memori, belum ada UI. Setiap baris di tabel "sudah selesai" merujuk berkas yang nyata dan dapat dibaca.
