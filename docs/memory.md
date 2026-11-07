# Damar — Local Memory (Phase 4)

Lapisan yang membuat Damar tidak perlu dijelaskan ulang setiap
percakapan. Semuanya lokal: satu berkas SQLite di `data/memory.db`,
tanpa layanan eksternal.

```
Hari 1  : "Saya sedang membuat ClipAdd."
Hari 7  : "Lanjut project."
Damar  : "Project ClipAdd berada di Workspace/ClipAdd, modul terakhir
           yang dikerjakan adalah downloader YouTube."
```

---

## Tiga lapis yang saling menunjuk

| Lapis | Isi | Contoh |
|---|---|---|
| **Entities** | Siapa/apa yang dirujuk | Yansiska (person), Honda Vario 125 (vehicle), Garasi (room), ClipAdd (project) |
| **Memories** | Apa yang terjadi / apa yang benar | "Motor Honda Vario keluar garasi pukul 08.13" |
| **Documents** | Sumber pengetahuan panjang | Manual UPS, datasheet sensor, catatan struktur NAS |

### Jenis memori

| Tipe | Untuk | Contoh |
|---|---|---|
| `episodic` | Peristiwa berwaktu | "Backup NAS selesai, 412 GB tersalin" |
| `semantic` | Fakta yang berlaku umum | "UPS APC Back-UPS Pro 1500 maksimum 865 watt" |
| `preference` | Selera & kebiasaan | "Suhu AC ruang kerja disetel 24 derajat" |
| `procedural` | Cara melakukan sesuatu | "Restart NAS: matikan container dulu, baru reboot" |

---

## Entity resolution

Satu hal nyata boleh punya banyak sebutan. Semuanya bermuara ke satu baris:

```
"ayah" ─┐
"bapak" ├─→ Budi Santoso (person, id=1)
"Pak Budi" ─┘

"motor saya" ─┐
"vario"       ├─→ Honda Vario 125 (vehicle, id=2, plate=B1234XYZ)
"Hondá Vario" ─┘
```

Urutan pencocokan: nama persis → alias persis → full-text. Nama
dinormalisasi (huruf kecil, tanpa diakritik, tanpa tanda baca), jadi
`"Hondá  Vario!"` dan `"honda vario"` adalah entitas yang sama.

Entitas yang ternyata kembar bisa digabung dengan `merge()`. Yang kalah
tidak dihapus melainkan diarahkan ke pemenang, sehingga memori lama yang
menunjuk id lama tetap terbaca.

---

## Pencarian hibrida

Dua jalur dipakai bersama karena masing-masing punya titik buta:

| Jalur | Unggul untuk | Contoh |
|---|---|---|
| **Kata kunci** (FTS5) | Nama, plat nomor, kode error, nama file | "B1234XYZ", "immich-server" |
| **Vektor** (embedding) | Parafrase | "berapa daya maksimal UPS" → "beban maksimum 865 watt" |
| **Entitas** | Menarik memori terkait meski katanya tak cocok | "apa yang terjadi di Garasi" |

Skor akhir menggabungkan relevansi, **kepentingan**, **kebaruan**
(peluruhan eksponensial, paruh waktu 21 hari), keterkaitan entitas, dan
status sematan. Memori tua tapi penting tidak kalah dari memori baru
yang sepele.

### Bahasa Indonesia

Klitik umum dipenggal saat menyusun query: `motornya` → `motor`,
`rumahku` → `rumah`. Ini menutup celah paling sering terjadi tanpa
stemmer penuh — penting karena pencarian vektor **tidak selalu
tersedia**.

---

## Embedding opsional

Titik desain terpenting: endpoint embedding sering tidak tersedia — saat
pengembangan di laptop, saat PC rumah reboot, saat model belum diunduh.

Karena itu embedding diperlakukan sebagai **peningkatan kualitas, bukan
syarat**:

1. Memori tetap tersimpan dan tetap bisa dicari lewat kata kunci.
2. Vektornya diisi belakangan oleh backfill saat endpoint hidup.
3. Status ditampilkan jujur di Console (`Mati` + alasannya).

Model embedding diatur lewat `DAMAR_EMBED_MODEL` (default
`nomic-embed-text`). Di PC rumah, unduh dulu:

```bash
```

Backfill jalan otomatis tiap 60 detik, atau manual lewat tombol
**Isi embedding** di Console.

---

## Dokumen

| Format | Status |
|---|---|
| PDF | ✅ via `pdf-parse` |
| DOCX | ✅ via `mammoth` |
| Markdown, TXT, CSV, JSON, HTML, berkas kode | ✅ natif |
| XLSX, PPTX, DOC lama | ❌ belum — ekspor ke PDF/DOCX dulu |

Dokumen dipecah menjadi chunk pada batas alami (judul → paragraf →
kalimat), bukan jumlah karakter mentah. Potongan yang terbelah di tengah
kalimat menghasilkan embedding kabur dan kutipan yang sulit dibaca.
Tiap chunk membawa judul bagian asalnya.

Dedup lewat hash isi: berkas yang sama tidak di-ingest dua kali.

---

## Konsolidasi

Tujuannya menjaga memori tetap **berguna**, bukan sekadar kecil:

- Fakta kedaluwarsa (`valid_until` lewat) diturunkan kepentingannya,
  **tidak dihapus** — ia tetap fakta historis yang sah.
- Memori episodik yang tidak penting dan tidak pernah dipanggil selama
  90 hari dihapus.
- Memori tersemat (`pinned`) dan sensitif tidak pernah disentuh.

Fakta yang berubah tidak ditimpa melainkan ditandai `superseded_by`,
karena riwayat "dulu benar, sekarang tidak" sering lebih berguna
daripada nilai terakhir saja.

---

## Yang dilihat model

Sebelum menjawab, memori relevan disisipkan ke system prompt (dibatasi
1800 karakter — yang langka adalah konteks model, bukan barisnya).
Model juga punya tool untuk menggali sendiri:

| Tool | Guna |
|---|---|
| `memory_remember` | Simpan fakta baru |
| `memory_recall` | Cari sebelum menjawab |
| `memory_forget` | Hapus atas permintaan eksplisit |
| `memory_entities` | Periksa apa yang sudah dikenal |
| `memory_documents` | Daftar sumber yang tersedia |

Memori bertanda `sensitive` **tidak** ikut terinjeksi otomatis.

---

## API

Semua di bawah `/api/v1/console`.

| Method | Endpoint | Guna |
|---|---|---|
| GET | `/memory/stats` | Ringkasan memori, entitas, dokumen, embedding |
| GET | `/memory` | Telusuri memori (filter tipe/sumber/entitas/waktu) |
| POST | `/memory` | Simpan memori |
| POST | `/memory/recall` | Pencarian hibrida |
| PATCH | `/memory/:id` | Ubah (termasuk `pinned`) |
| DELETE | `/memory/:id` | Hapus |
| POST | `/memory/consolidate?dryRun=true` | Pratinjau/jalankan perawatan |
| GET | `/memory/entities` | Daftar entitas + alias |
| GET | `/memory/entities/:id` | Detail + relasi + memori terkait |
| POST | `/memory/entities` | Tambah entitas |
| DELETE | `/memory/entities/:id` | Hapus entitas |
| GET | `/memory/documents` | Dokumen tersimpan |
| POST | `/memory/documents` | Ingest — `{path}`, `{directory}`, atau `{text}` |
| GET | `/memory/documents/:id/chunks` | Potongan sebuah dokumen |
| GET | `/memory/embeddings` | Status embedding |
| POST | `/memory/embeddings/backfill` | Isi vektor yang tertinggal |

> `path` dan `directory` dibaca oleh **daemon**, jadi tulis path menurut
> mesin daemon — bukan menurut laptop yang membuka Console.

---

## Skema

```
entities ──< entity_aliases
    │  └──< entity_relations >──┘
    │
    └──< memory_entities >── memories ──> documents ──< document_chunks
                                 │                          │
                                 └────── embeddings ────────┘
                                 └────── memories_fts (FTS5)
```

Vektor disimpan sebagai BLOB Float32 dengan norma pra-hitung; kemiripan
dihitung di JS atas kandidat hasil penyaringan. Untuk skala satu rumah
ini cukup dan tidak menambah dependensi native. Bila kelak membengkak,
`RecallService.applyVectorScores()` adalah tempat memasang indeks ANN.

---

## Konfigurasi

| Variabel | Default | Guna |
|---|---|---|
| `DAMAR_MEMORY_DB` | `data/memory.db` | Lokasi basis data memori |
| `DAMAR_EMBED_MODEL` | - | Model embedding (opsional) |
| `DAMAR_EMBED_URL` | - | Endpoint embedding OpenAI-compatible (opsional) |
