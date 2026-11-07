# ADR-001 — Aether OS berdiri di repositori terpisah dari Aether legacy

**Status:** Diterima
**Tanggal:** 2026-08-11
**Fase:** Phase 0

---

## Konteks

Sudah ada implementasi Aether di `C:\Workspace\Aether`:

- 440 berkas JavaScript, 42.970 baris, **1 berkas tes**
- Node.js CommonJS + Electron
- **Sedang berjalan di produksi**: daemon di port 3000 dengan autostart lewat Scheduled Task
- Melayani hal yang dipakai pemilik sehari-hari: Immich (4.198 foto & video terindeks), WhatsApp, Telegram, memori, 75 tool

Direktif §105 memerintahkan: *"Do not blindly overwrite an existing project"*, dan §106: *"Do not drag legacy architecture into the new system merely because it already exists."*

## Masalah

Di mana Aether OS dibangun, tanpa merusak sistem yang sedang dipakai?

## Opsi

**A. Tulis ulang di tempat (`C:\Workspace\Aether`)**
Ganti isi repo yang ada.

**B. Branch baru di repo yang sama**
`git checkout -b aether-os` lalu bangun di sana.

**C. Repositori baru terpisah (`C:\Workspace\AetherOS`)**
Legacy tetap utuh dan berjalan; sistem baru tumbuh di sampingnya.

**D. Monorepo yang menampung keduanya**
Pindahkan legacy ke `legacy/`, sistem baru di `core/`.

## Keputusan

**Opsi C** — repositori baru di `C:\Workspace\AetherOS`.

## Rasional

- **Legacy adalah produksi, bukan sekadar kode.** Daemon-nya autostart, memegang sesi WhatsApp, kunci API Immich, dan memori yang sudah terisi. Opsi A dan B akan membuat sistem yang dipakai sehari-hari mati di tengah pembangunan yang butuh berminggu-minggu.
- **Definition of Done (§221) mustahil dipenuhi lewat migrasi in-place.** Legacy punya 1 tes untuk 43.000 baris; menempelkan arsitektur baru di atasnya mewarisi utang tanpa jaring pengaman.
- **Beda bahasa.** Aether OS berbasis Python + TypeScript (ADR-002); legacy JavaScript CommonJS. Menggabungkannya dalam satu repo memaksa dua toolchain, dua CI, dua konvensi.
- **Opsi D ditolak** karena memindahkan legacy = menyentuh produksi, persis yang ingin dihindari. Monorepo dapat dipertimbangkan lagi setelah Aether OS terbukti dan legacy dipensiunkan.
- Repo terpisah membuat **pensiun legacy menjadi keputusan sadar** dengan tanggal jelas, bukan erosi diam-diam.

## Konsekuensi

**Positif**
- Legacy terus melayani pemilik tanpa gangguan selama pembangunan
- Aether OS bebas memilih bahasa, struktur, dan standar mutu sendiri
- Rollback = tidak melakukan apa-apa; risiko mendekati nol
- Batas "apa yang diwarisi" menjadi eksplisit lewat migrasi sadar

**Negatif**
- Dua repo harus dipelihara sementara
- Konsep yang dipakai ulang harus disalin dengan sengaja, bukan diimpor
- Butuh koordinasi port & sumber daya (legacy 3000, Aether OS 8080+)
- Ada masa dua sistem hidup bersamaan yang membingungkan jika tidak didokumentasikan

**Mitigasi**
- `docs/status.md` menyatakan dengan jelas sistem mana yang otoritatif untuk fungsi apa
- Aether OS memakai rentang port 8080+ agar tidak bentrok
- Kredensial **tidak** disalin dari `configs/` legacy; lahir ulang di secret storage

## Alternatif yang ditolak

| Opsi | Alasan penolakan |
|---|---|
| A — tulis ulang di tempat | Mematikan produksi selama pembangunan |
| B — branch baru | Checkout branch tetap mengganti berkas di disk yang sama; daemon berjalan bisa memuat kode setengah jadi |
| D — monorepo | Memindahkan legacy = menyentuh produksi; dua toolchain dalam satu repo tanpa manfaat sepadan pada tahap ini |
