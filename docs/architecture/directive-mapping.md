# Pemetaan Direktif → Damar yang Berjalan

**Tanggal:** 2026-08-11
**Dasar:** ADR-006 (strangler fig)

Setiap pasal direktif dinilai terhadap basis kode nyata (`C:\Workspace\Aether`, 440 berkas, 42.970 baris, Node CommonJS + Electron).

Tiga kemungkinan hasil:

| Kode | Arti |
|---|---|
| ✅ **TERAPKAN** | Dapat dipasang pada legacy apa adanya |
| 🔁 **GANTI** | Maksud pasal tercapai lewat cara lain yang cocok dengan Node |
| ⏳ **TUNDA** | Butuh prasyarat; dicatat beserta pemicunya |

**Tidak ada pasal yang boleh diabaikan diam-diam.** Yang tidak dapat diterapkan wajib punya pengganti tertulis.

---

## A. Yang langsung dapat diterapkan

Ini pola arsitektur, bukan fitur bahasa. Semua dapat diwujudkan di JavaScript.

| § | Pasal | Status | Catatan penerapan |
|---|---|---|---|
| 4 | Konstitusi | ✅ | `docs/constitution.md` sudah ada; mengikat legacy juga |
| 37 | **Kill switch** | ✅ | **Gap kritis.** Legacy tak punya STOP global. Prioritas #1 |
| 46 | **Verification Engine** | ✅ | **Gap terbesar.** Legacy melapor sukses tanpa verifikasi |
| 32 | Skema tool | ✅ | `AIToolRegistry` sudah punya skema; tambah metadata |
| 33 | Capability-based security | ✅ | Tambah lapisan izin di atas registry yang ada |
| 34 | Tingkat risiko L0–L5 | ✅ | Metadata pada definisi tool |
| 35 | Dry run | ✅ | Flag opsional per tool |
| 96 | Audit event | ✅ | Sistem event legacy sudah ada; tambah kelas audit |
| 110 | Error terstruktur | ✅ | Ganti string exception dengan objek error |
| 112 | Timeout | ✅ | Sudah sebagian (`TimeoutExecutor`); rapikan cakupannya |
| 140 | Anti-loop | ✅ | Deteksi tool/error/rencana berulang |
| 222 | Tanpa implementasi palsu | ✅ | Aturan disiplin, bukan kode |
| 231 | Pertahanan prompt injection | ✅ | Penandaan sumber pada konteks |
| 234 | Hierarki otoritas | ✅ | Konstitusi Pasal 1; ditegakkan di perakitan prompt |
| 20 | Provenance memori | ✅ | Tambah kolom pada skema memori SQLite |
| 13 | Penalaran temporal | ✅ | Tambah `valid_from`/`valid_until`/`superseded_by` |
| 224 | `docs/status.md` | ✅ | Sudah ada |
| 225 | `docs/roadmap.md` | ✅ | Sudah ada |
| 7 | Sistem ADR | ✅ | Sudah ada (ADR-001…006) |

---

## B. Yang diganti dengan solusi lebih cocok

Maksud pasal dipertahankan; caranya disesuaikan dengan kenyataan Node + produksi berjalan.

| § | Tuntutan asli | Pengganti | Alasan |
|---|---|---|---|
| 8 | Core Python | **Node tetap; Python hanya sidecar memori** | Menulis ulang 43.000 baris runtime berjalan melanggar §277. Kebutuhan ekosistem Python (Graphiti/Qdrant/Neo4j) terpenuhi lewat layanan terpisah di balik antarmuka milik Damar |
| 8 | Tauri | **Electron yang sudah ada** | Sudah berjalan dan dipakai. Tauri hanya bila Electron terbukti menghambat — belum terbukti |
| 8 | React + TypeScript | **Vanilla JS + JSDoc bertipe** | Console sudah vanilla dan bekerja. Menambah React = menulis ulang UI tanpa manfaat yang terbukti. Ketat-tipe dicapai lewat JSDoc + `checkJs` |
| 6 | Struktur monorepo baru | **Struktur legacy diperbaiki bertahap** | Memindahkan 440 berkas sekaligus memutus produksi |
| 8 | PostgreSQL | **SQLite dulu, PostgreSQL saat terbukti perlu** | SQLite sudah jalan dan cukup untuk satu pengguna. §56 (gerbang Ponytail) melarang infrastruktur tanpa kebutuhan terbukti |
| 259 | Modular monolith | **Sudah modular monolith** | Legacy memang begitu; tinggal dipertegas batas modulnya |
| 102 | Protokol bertipe | **JSDoc `@typedef` + validasi runtime** | Tanpa TypeScript, kontrak tetap dapat ditegakkan lewat JSDoc + pemeriksaan runtime di batas modul |
| 38 | Sandbox | **Proses anak terbatas + container Docker** | Node punya `child_process` dengan batas; beban berat masuk container yang sudah tersedia |
| 97 | OpenTelemetry | **Logging terstruktur dulu, OTel saat ada yang membaca** | Memasang OTel tanpa backend pengumpul hanya menambah dependensi. Skema log dibuat siap-OTel |

---

## C. Yang ditunda beserta pemicunya

| § | Pasal | Pemicu untuk mulai |
|---|---|---|
| 14–19 | Memori berlapis L0–L6 penuh | Setelah provenance + temporal terpasang di memori yang ada |
| 26 | Model Router penuh | Sebagian sudah ada (fallback + cache kesehatan); dilengkapi setelah tingkat risiko |
| 28 | Planner DAG | Setelah Verification Engine — merencanakan tanpa memverifikasi tidak ada gunanya |
| 50 | Research engine | Setelah provenance memori |
| 52 | Analyst | Setelah sidecar Python ada |
| 60–61 | Vision / CCTV | Belum ada kamera di jaringan; vision dasar sudah jalan |
| 74 | Damar Lab | Setelah telemetri per-model tersedia |
| 75 | Perbaikan diri | Setelah sandbox + audit + kill switch lengkap |
| 76 | Digital Twin | Sebagian sudah ada (`nasService`, `systemController`) |
| 88 | Avatar Three.js | **Sudah ada dan baru dirombak** |
| 216 | Robotika | Di luar cakupan; abstraksi dijaga bersih |

---

## D. Yang sudah dipenuhi legacy

Direktif menganggap ini harus dibangun; sebagian sudah ada dan bekerja.

| § | Pasal | Bukti di legacy |
|---|---|---|
| 10 | Event bus | `src/core/events/` — event bertipe kelas |
| 32 | Tool registry | `src/ai/tools/AIToolRegistry` — 75 tool aktif |
| 39 | Skill system | `src/skillEngine/`, `src/skills/` |
| 42 | Sistem agen | `src/agent/` |
| 26 | Provider model | `src/ai/providers/` — factory + mapper + fallback |
| 79 | Mode offline | Otak lokal llama.cpp terbukti bekerja tanpa internet |
| 80 | Mode terdegradasi | Rantai fallback cloud → otak lokal terbukti (tanpa satu permintaan gagal) |
| 62 | Audio | STT/TTS terpasang (container perlu dipulihkan) |
| 88–91 | Avatar | Hologram Three.js + mood + kegiatan mandiri + berjalan |
| 93 | Communication bus | WhatsApp, Telegram, Console, CLI — satu core |
| 129 | Boot sequence | `src/bootstrap/` |

---

## E. Urutan kerja

Batas keamanan lebih dulu — inilah yang membuat otonomi layak dipercaya (§275).

| Prioritas | Item | Alasan |
|---|---|---|
| **P0** | Kill switch (§37) | Tidak ada cara menghentikan Damar saat ini |
| **P0** | Tingkat risiko + capability (§33–34) | 75 tool berjalan tanpa otorisasi berjenjang |
| **P0** | Verification Engine (§46) | Melapor sukses tanpa bukti |
| **P1** | Error terstruktur (§110) | Prasyarat recovery yang benar |
| **P1** | Audit event (§96) | Prasyarat otonomi |
| **P1** | Anti-loop (§140) | Mencegah pemborosan tak terbatas |
| **P2** | Provenance + temporal memori (§13, §20) | Prasyarat research & konflik memori |
| **P2** | Hierarki otoritas di prompt (§231, §234) | Pertahanan injeksi |
| **P3** | Sidecar memori Python (Graphiti/Qdrant) | Setelah fondasi kokoh |

---

## Catatan

Pemetaan ini adalah dokumen hidup. Setiap pasal yang berpindah status wajib diperbarui di sini, agar tidak ada tuntutan direktif yang hilang tanpa jejak.
