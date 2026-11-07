# ADR-006 — Evolusi di tempat (strangler fig), bukan penulisan ulang terpisah

**Status:** Diterima — **menggantikan ADR-001**
**Tanggal:** 2026-08-11
**Fase:** Phase 0 (revisi)

---

## Konteks

ADR-001 memutuskan membangun Aether OS sebagai repositori greenfield terpisah, dengan legacy dibiarkan hidup sampai penggantinya siap.

Pemilik menolak arah itu:

> "kombinasikan saja aturan baru tanpa mematikan yang lama jika memang aturan baru tidak bisa di pakai maka carikan solusinya saja sebagai pengganti yang lebih baik"

Instruksi ini mengubah tujuan: bukan **menggantikan** sistem, melainkan **mengangkat** sistem yang ada ke standar direktif — dan bila sebuah aturan tidak dapat diterapkan pada basis kode yang ada, mencari pengganti yang lebih baik, bukan memaksakan atau menyerah.

## Masalah

Bagaimana menerapkan direktif 280-pasal pada sistem berjalan berisi 43.000 baris JavaScript, tanpa jeda produksi, tanpa penulisan ulang total, dan tanpa mengencerkan standar mutu direktif?

## Opsi

**A. Greenfield terpisah** (ADR-001). Ditolak pemilik.

**B. Penulisan ulang besar-besaran di tempat.** Ganti isi repo legacy ke Python sekaligus. Mematikan produksi berminggu-minggu — persis yang dilarang.

**C. Strangler fig.** Legacy tetap menjadi runtime yang berjalan. Kemampuan baru masuk sebagai modul di dalamnya atau layanan di sampingnya, di balik antarmuka yang dimiliki Aether. Fungsi lama dipensiunkan satu per satu setelah penggantinya terbukti.

**D. Hanya menempelkan dokumen.** Konstitusi ditulis, kode tidak berubah. Teater kepatuhan.

## Keputusan

**Opsi C — strangler fig.**

Aturannya:

1. **Legacy adalah runtime produksi** dan tetap dapat dijalankan setiap saat.
2. **Setiap pasal direktif dinilai satu per satu** terhadap basis kode nyata, dengan tiga kemungkinan hasil:
   - **TERAPKAN** — dapat dipasang pada legacy apa adanya
   - **GANTI** — maksudnya tercapai lewat cara lain yang cocok dengan JavaScript/Node
   - **TUNDA** — butuh prasyarat yang belum ada; dicatat dengan syarat pemicunya
3. **Tidak ada pasal yang boleh diam-diam diabaikan.** Yang tidak dapat diterapkan wajib punya pengganti tertulis beserta alasannya (`docs/architecture/directive-mapping.md`).
4. **Setiap perubahan menjaga sistem tetap berjalan** (§277). Tidak ada commit yang meninggalkan Aether dalam keadaan mati.
5. **Batas keamanan lebih dulu.** Kill switch, tingkat risiko, verifikasi, dan audit didahulukan sebelum fitur kognitif — karena inilah yang membuat otonomi layak dipercaya (§275).

## Rasional

- **Sistem berjalan punya nilai yang tidak tergantikan.** Sesi WhatsApp, kunci Immich, 4.198 aset terindeks, memori terisi, autostart yang sudah stabil. Greenfield membuang semua itu demi kebersihan arsitektur.
- **Direktif sendiri memerintahkannya.** §106 menuntut migrasi disengaja, bukan pembuangan borongan. §277 menuntut sistem tetap dapat dijalankan sepanjang pembangunan. §218 melarang overengineering rilis pertama. Strangler fig adalah pembacaan paling setia atas ketiganya.
- **Nilai terbesar direktif bukan pada bahasanya.** Verification engine, hierarki otoritas, tingkat risiko, provenance, kill switch, dan degradasi bersuara — semuanya adalah **pola arsitektur**, bukan fitur Python. Semua dapat diwujudkan di JavaScript.
- **Bahasa adalah detail implementasi.** ADR-002 memilih Python karena ekosistem memori (Graphiti, Qdrant, Neo4j). Kebutuhan itu tetap nyata, tetapi terpenuhi lebih baik lewat **layanan sidecar** daripada menulis ulang 43.000 baris runtime yang sudah bekerja.

## Konsekuensi

**Positif**
- Nol jeda produksi; pemilik terus memakai Aether selama pembangunan
- Perbaikan terasa segera, bukan setelah berbulan-bulan
- Setiap langkah dapat diuji terhadap penggunaan nyata
- Rollback per-perubahan, bukan per-sistem

**Negatif**
- Basis kode akan menampung dua generasi arsitektur untuk sementara
- Utang legacy (tanpa tes, tanpa tipe) harus dibayar bertahap, bukan dihindari
- Butuh disiplin agar modul baru tidak tertular pola lama
- Beberapa cita-cita direktif (core Python murni) tidak akan pernah tercapai dalam bentuk aslinya

**Mitigasi**
- Modul baru wajib: bertipe (JSDoc + `checkJs`), teruji, terobservasi
- Setiap kemampuan yang dipindahkan mencatat tanggal pensiun komponen lama
- `docs/architecture/directive-mapping.md` menjaga agar tidak ada pasal yang hilang diam-diam

## Dampak pada ADR sebelumnya

| ADR | Status baru |
|---|---|
| ADR-001 pemisahan repositori | **Digantikan.** Kerja berlangsung di `C:\Workspace\Aether` |
| ADR-002 Python core | **Diubah.** Runtime tetap Node. Python dipakai untuk layanan sidecar memori bila terbukti perlu |
| ADR-003 strategi tanpa GPU | **Tetap berlaku penuh.** Tidak bergantung bahasa |
| ADR-004 lokasi data infrastruktur | **Tetap berlaku penuh.** |
| ADR-005 penundaan Tauri | **Diubah.** Electron yang sudah ada tetap dipakai; Tauri hanya bila Electron terbukti menghambat |

Dokumen di `C:\Workspace\AetherOS` dipindahkan ke `C:\Workspace\Aether\docs` agar arsitektur menyatu dengan kode yang diaturnya.

## Alternatif yang ditolak

| Opsi | Alasan |
|---|---|
| A — greenfield terpisah | Ditolak pemilik; membuang nilai sistem berjalan |
| B — penulisan ulang di tempat | Mematikan produksi berminggu-minggu |
| D — dokumen tanpa perubahan kode | Teater kepatuhan; melanggar §222 |
