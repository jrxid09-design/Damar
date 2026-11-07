# Damar OS — Roadmap

Setiap milestone harus **dapat dijalankan** saat selesai. Tidak ada fitur palsu, tidak ada `success` untuk operasi yang tak terjadi (§222).

Definition of Done (§221): `diimplementasi · bertipe · teruji · terintegrasi · terobservasi · terdokumentasi · aman · dapat dipulihkan`.

---

## Phase 0 — Fondasi & Audit ✅

- [x] Audit lingkungan (`docs/architecture/initial-environment-audit.md`)
- [x] Konstitusi (`docs/constitution.md`)
- [x] Sistem ADR (ADR-001 … ADR-005)
- [x] Roadmap & status
- [ ] Struktur repositori
- [ ] Sistem konfigurasi bertipe
- [ ] Logging terstruktur
- [ ] Kontrak event
- [ ] Kerangka tes + CI

---

## Milestone 0.1 — DAMAR FOUNDATION

Membuktikan kernel berdiri, bukan membuat tampilan mengesankan.

| Komponen | Status |
|---|---|
| Damar Core (kernel deterministik) | ⬜ |
| Event Bus (event bertipe, correlation/causation) | ⬜ |
| Config (bertipe, per-lingkungan) | ⬜ |
| Logging terstruktur | ⬜ |
| Health System | ⬜ |
| Model Router (sadar kemampuan & latensi) | ⬜ |
| Tool Registry (skema, izin, tingkat risiko) | ⬜ |
| Skill Registry | ⬜ |
| Task Engine (siklus hidup, checkpoint) | ⬜ |
| Basic Memory (PostgreSQL) | ⬜ |
| Basic API (FastAPI, berversi) | ⬜ |
| UI web dasar (browser; Tauri ditunda — ADR-005) | ⬜ |

**Kriteria selesai (§219):** pengguna bertanya → Damar paham → ambil memori → pakai model lokal → buat tugas bila perlu → pakai tool aman → **verifikasi hasil** → simpan memori → jawab.

---

## Milestone 0.2 — DAMAR COGNITION

Intent Engine · Context Engine (+ anggaran konteks) · Planner (DAG) · Executor · **Verification Engine** · Memory Router · Graph Memory (Neo4j + Graphiti) · Vector Memory (Qdrant)

---

## Milestone 0.3 — DAMAR ENGINEER

Serena · Git · Coding Agent · Debugger · Tester · Reviewer · **Sandbox**

---

## Milestone 0.4 — DAMAR ANALYST

Ingestion · Profiler · Statistik · Visualisasi · Analyst Agent · Research Agent (dengan provenance)

---

## Milestone 0.5 — DAMAR EMBODIED

Tauri shell · Three.js avatar · Voice (STT/TTS) · Persepsi layar · Mood · Interaksi kursor

---

## Milestone 0.6 — DAMAR AUTONOMY

Scheduler · Goals · Proactive · Background tasks · Dream mode · **Attention engine**

---

## Milestone 0.7 — DAMAR WORLD

World Model · PC · NAS · Jaringan · Devices · CCTV · Home automation

---

## Milestone 0.8 — DAMAR LAB

Benchmarks · Experiments · Perbandingan model · Skill compiler · Belajar dari kegagalan · Self-diagnostics

---

## Milestone 0.9 — DAMAR OS

Stabilitas · Keamanan · Performa · Recovery · UX · Observability · Offline mode

---

## Milestone 1.0 — DAMAR OS 1.0

Lulus seluruh pertanyaan verifikasi §276.

Tabel ini **tidak diisi dari ingatan**. Ia hasil `npm run audit`
([`scripts/audit-276.js`](../scripts/audit-276.js)) yang menguji sistem yang
benar-benar berjalan dan menulis buktinya ke `docs/audit-276.json`. Roadmap yang
mencentang kotak berdasarkan niat adalah dokumen yang menyesatkan pemiliknya
sendiri (§222).

**Terakhir dijalankan: 2026-08-12 — 16 lulus · 0 sebagian · 0 belum.**

| Pertanyaan | Status | Bukti |
|---|---|---|
| Dapat mengingat? | ✅ | Simpan lalu panggil ulang berhasil |
| Memahami waktu? | ✅ | Waktu lokal + zona; memori bi-temporal (`occurredAt` / `validFrom`) |
| Memahami relasi? | ✅ | Hubungan ditelusuri lewat memori bersama, dengan ukurannya |
| Memahami lingkungannya? | ✅ | World Model: mesin, disk, layanan, model termuat — tiap fakta bersumber & berwaktu |
| Dapat memakai tool? | ✅ | Dieksekusi di daemon lewat chokepoint tunggal |
| Dapat menyusun rencana? | ✅ | DAG + dependensi + siklus; loop eksekusi memakainya untuk bacaan paralel |
| **Dapat memverifikasi tindakan?** | ✅ | Klaim sukses palsu terbaca `failed` |
| Dapat pulih dari kegagalan? | ✅ | Checkpoint bertahan; langkah dipilah — tool aman diulang sendiri, yang destruktif menunggu izin |
| Dapat menjelaskan keputusan dengan aman? | ✅ | Jurnal rekayasa dapat dipanggil; penanda palsu dinetralkan |
| Dapat bekerja offline? | ✅ | Dengan seluruh host non-lokal tak terjangkau, jalur inferensi tetap terjawab |
| Dapat membedakan fakta dari inferensi? | ✅ | Asal-usul ikut ke konteks; prompt memerintahkan menyampaikannya sebagai dugaan |
| Dapat mempelajari prosedur? | ✅ | Pengalaman perbaikan disimpan lalu dipanggil kembali |
| Dapat memperbaiki alur dengan aman? | ✅ | Git diverifikasi mandiri; proses anak tidak mewarisi rahasia, cwd terkurung |
| **Dapat menghentikan dirinya?** | ✅ | STOP menahan tool; bertahan lintas restart |
| Pemilik dapat memeriksa isi memorinya? | ✅ | Panel memori + daftar isi |
| Pemilik dapat mengendalikan kemampuannya? | ✅ | Ambang risiko, saklar gerbang, izin per-tool |

### Yang 16/16 ini TIDAK berarti

Angka ini jujur terhadap pertanyaannya, dan pertanyaannya punya batas. Yang
masih terbuka, dinyatakan di sini supaya tidak hilang di balik centang:

- **Sandbox bukan jail sistem operasi.** Rahasia tidak diwariskan, cwd
  terkurung, ada batas waktu — tetapi perintah tetap berjalan dengan hak
  pengguna yang sama dan tetap dapat menyentuh jaringan.
- **Offline diuji di tingkat proses**, dengan host non-lokal dibuat tak
  terjangkau pada lapisan socket dan **inferensi sungguhan** dijalankan di
  sana. Jaringan sungguhan tidak pernah diputus (itu dapat memutus Tailscale
  dan akses pemilik) — jadi yang terbukti: menjawab tidak membutuhkan host di
  luar mesin ini. Yang belum: perilaku saat jaringan putus **di tengah**
  permintaan, dan saat layanan luar sedang mati.
  Versi pertama pemeriksaan ini lulus karena cacat alat ukur; lihat
  `docs/status.md` baris "Uji offline". Satu pemeriksaan yang lulus karena
  alasan salah adalah alasan cukup untuk menelaah lima belas sisanya dengan
  kecurigaan yang sama sebelum 16/16 dibaca sebagai 1.0.
- **Relasi = kemunculan bersama.** Kaitan lemah yang dilaporkan beserta
  ukurannya, bukan penalaran sebab-akibat.
- **Paralel hanya untuk bacaan (tool aman).** Tindakan destruktif tetap
  berurutan, dan itu disengaja.
- **Melanjutkan rencana masih separuh:** langkah baca diulang sendiri,
  selebihnya menunggu izin pemilik (Pasal 2.1).

1.0 bukan ketika tabel penuh centang, melainkan ketika batas-batas di atas
sudah dipilih secara sadar — bukan ditemukan saat sesuatu gagal.

---

## Catatan koeksistensi — **digantikan ADR-006**

ADR-001 dulu merencanakan Damar OS sebagai repositori terpisah di
`C:\Workspace\DamarOS`, dengan legacy berjalan berdampingan sampai
digantikan.

**Itu tidak lagi berlaku.** ADR-006 menggantinya dengan evolusi di tempat
(strangler fig): pekerjaan terjadi di `C:\Workspace\Aether`, Node tetap,
Electron tetap. Tidak ada sistem kedua yang menunggu menggantikan — yang ada
satu sistem yang tumbuh, dan setiap kemampuan baru harus lulus §276 di sana.

Karena itu tabel milestone di atas perlu dibaca sebagai **peta kemampuan**,
bukan urutan pembangunan sistem baru. Beberapa komponen yang tertulis ⬜
sebenarnya sudah berjalan di dalam sistem yang ada — `npm run audit` adalah
sumber kebenarannya, bukan tabel ini.
