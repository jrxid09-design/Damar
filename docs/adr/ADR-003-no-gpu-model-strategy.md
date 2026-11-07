# ADR-003 — Strategi model untuk mesin tanpa GPU diskrit

**Status:** Diterima
**Tanggal:** 2026-08-11
**Fase:** Phase 0

---

## Konteks

Direktif menetapkan Aether **local-first** (§2 Principle 2, §27): tetap berguna tanpa internet, cloud hanya akselerator. Direktif juga menargetkan Vision (§60), CCTV (§61), Audio (§62), coding (§54), research (§50), dan analisis data (§52) — semuanya beban inferensi berat.

Audit mengungkap kenyataan keras:

| | |
|---|---|
| GPU | **Intel UHD 770 saja** — VRAM 2 GB bersama |
| GPU diskrit | **Tidak ada** |
| CUDA | Tidak tersedia |

Pengukuran nyata di mesin ini (`llama3.1:8b` Q4, CPU-only):

| Metrik | Hasil |
|---|---|
| Cold load dari NVMe | 10,2 detik |
| Warm, prompt pendek | 2,7 detik |
| Prompt eval | ± 43 token/detik |
| Prompt 11.900 token (75 tool) | **94 detik** — melewati batas waktu, tak terpakai |
| Prompt 3.900 token (16 tool) | dapat dipakai |

Angka-angka ini bukan estimasi; terukur langsung.

## Masalah

Bagaimana memenuhi janji "local-first" ketika inferensi lokal 30–40× lebih lambat daripada asumsi bahwa ada GPU?

## Opsi

**A. Local-only murni.** Semua lewat otak lokal in-process. Jujur secara privasi, tetapi respons 10–90 detik untuk tugas ber-tool.

**B. Cloud-only.** Cepat, tetapi melanggar Principle 2 dan mengirim seluruh konteks pengguna ke luar.

**C. Hybrid sadar-latensi dengan lokal sebagai lantai jaminan.** Router memilih berdasarkan kelas tugas, anggaran latensi, dan klasifikasi privasi; lokal selalu tersedia sebagai fallback.

**D. Beli GPU.** Di luar kewenangan; keputusan belanja milik pemilik.

## Keputusan

**Opsi C.**

Aturan yang mengikat Model Router:

1. **Privasi menang atas kecepatan.** Konteks bertanda `LOCAL_ONLY` / `NEVER_CLOUD` (§94) **tidak pernah** keluar, apa pun latensinya.
2. **Anggaran konteks wajib** (§25). Prompt lokal dibatasi. Bukti terukur: 75 tool = 11.900 token = 94 detik; 16 tool = 3.900 token = terpakai. Pemilihan tool berbasis relevansi bukan optimasi, melainkan **syarat kelayakan**.
3. **Context selalu eksplisit.** Context besar otomatis di CPU membengkakkan RAM 14 GB dan melipatgandakan waktu prompt-eval. Terverifikasi: 65536 → 14 GB, 8192 → 6,2 GB.
4. **Lokal adalah lantai, bukan plafon.** Saat internet mati atau kuota cloud habis, Aether **tetap menjawab** — lebih lambat, dan mengatakannya terus terang.
5. **Degradasi bersuara** (§80). Mode terdegradasi wajib terlihat pengguna, bukan disembunyikan.
6. **Vision/STT/TTS dianggap operasi mahal**, bukan realtime. Dijadwalkan, di-batch, atau dilepas ke cloud sesuai kebijakan — tidak pernah dijanjikan instan.

## Rasional

- Local-first adalah **jaminan kedaulatan, bukan janji performa**. Sistem harus tetap hidup tanpa internet; ia tidak wajib sama cepatnya.
- Opsi A gagal syarat kegunaan: asisten yang butuh 90 detik untuk satu balasan tidak akan dipakai, dan sistem yang tidak dipakai tidak bernilai.
- Opsi B melanggar konstitusi dan membuat Aether mati saat internet putus.
- Pengalaman legacy membuktikan hybrid berhasil: Groq menjawab ~1 detik, dan saat kuota habis rantai jatuh ke otak lokal **tanpa satu permintaan pun gagal**. Pola itu terbukti di mesin ini.

## Konsekuensi

**Positif**
- Aether berguna sehari-hari sekaligus tahan saat offline
- Batas privasi ditegakkan mesin, bukan kebiasaan
- Anggaran konteks menekan token, latensi, dan halusinasi sekaligus

**Negatif**
- Router menjadi komponen kritis — bug di sana berdampak ke semua tugas
- Perlu telemetri per-model per-kelas-tugas agar routing dapat dievaluasi (§187)
- Jalur cloud membutuhkan privacy gateway + redaksi (§95) sejak awal, bukan belakangan
- Pemilihan tool berbasis relevansi berisiko menyembunyikan kemampuan yang sebenarnya dibutuhkan

**Mitigasi**
- Setiap keputusan routing menghasilkan event yang dapat diaudit
- Anggaran tool dapat dikonfigurasi dan dapat dimatikan
- Benchmark (§188) mengukur apakah routing benar-benar lebih baik, bukan sekadar terasa

## Alternatif yang ditolak

| Opsi | Alasan |
|---|---|
| A — local-only | Terukur tidak dapat dipakai untuk tugas ber-tool (94 detik) |
| B — cloud-only | Melanggar Principle 2; mati saat offline; seluruh konteks keluar |
| D — beli GPU | Keputusan belanja milik pemilik; arsitektur tidak boleh mengasumsikannya |

## Catatan untuk masa depan

Bila kelak dipasang GPU diskrit, ADR ini **tidak dibatalkan** — hanya bobot routing yang bergeser ke lokal. Arsitekturnya sudah menampung kedua dunia. Itulah alasan router dibuat sadar-kemampuan sejak awal, bukan di-hardcode ke satu provider.
