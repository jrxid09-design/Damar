# ADR-004 — Data infrastruktur ditempatkan di D:, bukan C:

**Status:** Diterima
**Tanggal:** 2026-08-11
**Fase:** Phase 0

---

## Konteks

Stack target butuh PostgreSQL, Neo4j, Qdrant, dan MinIO. Audit disk:

| Drive | Bebas | Media |
|---|---|---|
| C: | **86,2 GB** | NVMe SSD |
| D: | 815,8 GB | HDD SATA |
| E: | 619,9 GB | HDD SATA (disk dinamis) |

C: sudah menanggung Windows, Docker image store (7,9 GB), dan sisa state Docker rusak yang tak terhapus (6,38 GB).

## Masalah

Di mana volume data infrastruktur diletakkan?

## Opsi

**A. Semua di C:.** Tercepat (NVMe), tetapi ruang tak cukup.
**B. Semua di D:.** Lapang, tetapi HDD.
**C. Semua di E:.** Lapang, tetapi disk dinamis dengan riwayat bermasalah.
**D. Terbagi menurut karakteristik beban.**

## Keputusan

**Opsi D**, dengan D: sebagai drive infrastruktur utama:

| Data | Lokasi | Alasan |
|---|---|---|
| Kode Aether OS | `C:\Workspace\AetherOS` | Kecil; kompilasi & tooling diuntungkan NVMe |
| Model lokal | `models/` proyek (tetap) | **Terukur**: cold load jauh lebih cepat dari NVMe vs HDD |
| PostgreSQL | `D:\AetherOS\data\postgres` | Butuh ruang, toleran latensi |
| Neo4j | `D:\AetherOS\data\neo4j` | Idem |
| Qdrant | `D:\AetherOS\data\qdrant` | Idem |
| MinIO / artifacts | `D:\AetherOS\data\minio` | Bisa tumbuh besar |
| Backup | `E:\AetherOS\backup` | Drive fisik berbeda dari data utama |

## Rasional

- **Model tetap di NVMe karena terbukti.** Memindahkannya ke HDD memperlambat cold load **6,4×** (10,2 → 65,3 detik). Ini bukan tebakan; sudah diukur dengan memindahkan 21,75 GB bolak-balik.
- **Database toleran HDD, model tidak.** Beban database Aether didominasi kueri kecil dengan cache di RAM (31,7 GB tersedia). Model harus membaca berkas 5–9 GB berurutan setiap cold start.
- **Backup harus beda disk fisik.** D: dan E: adalah disk berbeda (disk 0 dan disk 1), jadi kegagalan satu disk tidak menghapus data sekaligus cadangannya.
- **E: dihindari untuk data utama** karena disk dinamis dengan 292 GB tak teralokasi yang tidak bisa digabung, dan sudah dipakai Immich.

## Konsekuensi

**Positif**
- C: tetap punya ruang napas untuk Windows, toolchain, dan model
- Cold start model tetap cepat
- Backup terpisah secara fisik dari data

**Negatif**
- Database di HDD lebih lambat daripada NVMe — diterima; dapat dipindah bila terbukti jadi hambatan
- Konfigurasi jadi tidak seragam: perlu didokumentasikan agar tidak membingungkan

**Mitigasi**
- Semua jalur data dideklarasikan lewat env var, bukan hardcode — memindahkan volume nanti hanya mengubah konfigurasi
- Metrik latensi database dipantau sejak awal (§97)

## Alternatif yang ditolak

| Opsi | Alasan |
|---|---|
| A — semua di C: | 86 GB tidak cukup; database akan menghabiskan drive sistem |
| B — semua di D: | Memaksa model ke HDD; 6,4× lebih lambat, terukur |
| C — semua di E: | Disk dinamis bermasalah; sudah dipakai Immich |
