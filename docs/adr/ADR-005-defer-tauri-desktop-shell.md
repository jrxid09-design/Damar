# ADR-005 — Shell desktop (Tauri/Rust) ditunda sampai Milestone 0.5

**Status:** Diterima
**Tanggal:** 2026-08-11
**Fase:** Phase 0

---

## Konteks

Direktif §8 menetapkan Tauri sebagai shell desktop dan §252 menempatkan avatar/UI di Milestone 0.5. Audit menemukan **Rust dan Cargo belum terpasang**, sementara C: hanya menyisakan 86,2 GB (toolchain Rust + target build ± 2–3 GB).

Milestone 0.1 (§248) menuntut: Core, Event Bus, Config, Logging, Health, Model Router, Tool Registry, Skill Registry, Task Engine, Basic Memory, Basic API, **Basic Desktop Shell**.

## Masalah

Apakah Rust/Tauri harus dipasang sekarang demi "Basic Desktop Shell", atau ditunda?

## Opsi

**A. Pasang Rust + Tauri sekarang.** Sesuai baseline sejak awal.
**B. Tunda; pakai UI web di browser untuk Milestone 0.1.**
**C. Ganti Tauri dengan Electron.** Node sudah ada.

## Keputusan

**Opsi B.** Milestone 0.1 memakai UI web yang dilayani FastAPI dan dibuka di browser. Tauri masuk di Milestone 0.5 bersama avatar dan voice.

## Rasional

- **Shell bukan jalur kritis.** Yang harus dibuktikan Milestone 0.1 adalah kernel, event bus, memori, dan verifikasi — semuanya headless. Shell hanya cara menampilkannya.
- **UI-nya identik.** Tauri dan browser sama-sama merender React + TypeScript. Memindahkannya ke Tauri nanti berarti membungkus, bukan menulis ulang.
- **§107 menuntut instalasi bertahap dan beralasan.** Memasang toolchain Rust 2–3 GB di drive yang sisa 86 GB, demi fitur yang belum dibutuhkan, melanggar aturan itu.
- **§218 melarang overengineering rilis pertama.**
- **Opsi C ditolak**: Electron adalah arsitektur legacy yang justru ingin ditinggalkan, dan menambah runtime Node ke core Python (bertentangan dengan ADR-002).

## Konsekuensi

**Positif**
- Milestone 0.1 lebih cepat sampai ke keadaan dapat dijalankan
- C: tidak terbebani lebih awal dari perlunya
- Keputusan shell diambil saat kebutuhan avatar/voice sudah konkret

**Negatif**
- Belum ada aplikasi desktop native sampai 0.5
- Integrasi OS (tray, notifikasi, global hotkey) tertunda
- Ada risiko UI web menumpuk asumsi browser yang menyulitkan pembungkusan nanti

**Mitigasi**
- UI ditulis tanpa API khusus browser di lapisan inti
- Semua akses sistem lewat API backend, bukan langsung dari renderer — sehingga pembungkusan Tauri nanti tidak mengubah logika

## Alternatif yang ditolak

| Opsi | Alasan |
|---|---|
| A — Rust sekarang | 2–3 GB di drive sempit untuk fitur non-kritis; melanggar §107 |
| C — Electron | Arsitektur legacy yang ditinggalkan; menambah runtime kedua |
