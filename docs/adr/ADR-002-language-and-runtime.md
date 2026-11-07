# ADR-002 — Bahasa dan runtime: Python untuk core, TypeScript untuk UI

**Status:** Diterima
**Tanggal:** 2026-08-11
**Fase:** Phase 0

---

## Konteks

Direktif §8 menetapkan baseline: core backend Python, UI React + TypeScript, Rust bila terbukti perlu. Aether legacy seluruhnya JavaScript CommonJS (43.000 baris). Audit menemukan Python 3.11.15 (dikelola `uv`), Node 24.19, dan **tidak ada Rust**.

## Masalah

Melanjutkan JavaScript agar bisa memakai ulang kode legacy, atau pindah ke Python sesuai baseline?

## Opsi

**A. Tetap JavaScript/Node.** Pakai ulang legacy langsung.
**B. Python untuk core, TypeScript untuk UI.** Sesuai baseline direktif.
**C. Rust untuk core.** Performa maksimal.
**D. Campur: Node untuk runtime, Python untuk AI.** Dua proses.

## Keputusan

**Opsi B.** Core Python 3.11+ (dikelola `uv`), UI TypeScript + React.

## Rasional

- **Ekosistem menentukan.** Hampir semua komponen yang ditunjuk direktif berbahasa Python secara native: Graphiti, klien Qdrant, klien Neo4j, faster-whisper, pandas/polars, Serena, OpenTelemetry SDK. Di Node semuanya butuh binding atau layanan terpisah.
- **Typing.** Python modern + Pydantic memberi kontrak yang dapat divalidasi runtime — penting untuk skema event (§10), skema tool (§32), dan error terstruktur (§110). Legacy tanpa lapisan tipe sama sekali.
- **Opsi A ditolak**: memakai ulang legacy adalah keuntungan semu. Utang terbesarnya (tanpa tes, tanpa tipe, tanpa policy, tanpa sandbox) justru ikut terbawa.
- **Opsi C ditolak untuk sekarang**: Rust belum terpasang, waktu iterasi lebih lambat, dan tidak ada bukti performa jadi hambatan. §258 melarang optimasi prematur. Rust tetap terbuka untuk komponen kritis bila pengukuran membuktikannya.
- **Opsi D ditolak**: dua runtime untuk satu core berarti dua siklus hidup, dua model error, dua tempat bug — melanggar §259 (modular monolith dulu).

## Konsekuensi

**Positif**
- Integrasi langsung dengan seluruh stack memori dan AI tanpa lapisan jembatan
- Pydantic menegakkan skema event/tool/error sejak awal
- `uv` sudah ada dan cepat

**Negatif**
- Kode legacy tidak dapat diimpor; konsep harus ditulis ulang
- Python lebih lambat daripada Rust untuk jalur panas — diterima sampai terbukti bermasalah
- Butuh disiplin: type hints wajib, mypy di CI

## Alternatif yang ditolak

| Opsi | Alasan |
|---|---|
| A — JavaScript | Pemakaian ulang semu; mewarisi utang terbesar legacy |
| C — Rust core | Belum terpasang; iterasi lambat; optimasi prematur (§258) |
| D — Node + Python | Dua runtime untuk satu core; melanggar §259 |
