# SEMANTIC DESKTOP — Substrat Konteks Desktop V0

Dokumen ini menjelaskan substrat **Semantic Desktop**: sistem yang
menjawab *"apa yang sedang terjadi di komputer ini sekarang?"* — bukan
sekadar *"proses apa yang berjalan?"*. Lokasi: `src/desktop/`, tes:
`tests/desktop/`.

Status: **V0 deterministik, observasi saja**. Tidak ada actuation OS,
tidak ada tangkapan layar kontinu, tidak ada integrasi daemon produksi.

---

## Prinsip inti: RAW OS STATE != SEMANTIC CONTEXT

```
raw:    process = notepad.exe ; window = "catatan.txt - Notepad"
semantic:
  entity  DOCUMENT catatan.txt
  rel     DISPLAYED_IN → WINDOW → ACTIVE_IN → APPLICATION notepad
  role    currently_editing
```

Setiap entitas membawa `provenance` (dari adapter mana) dan
`confidence` (seberapa yakin). Seleksi teks ≠ teks clipboard sembaran;
konteks visual aktif ≠ screenshot desktop; halaman browser ≠ proses
browser.

## Peta konsep

| Konsep | Isi |
|---|---|
| `types.js` | ENTITY_TYPE (13), RELATIONSHIP (10), DESKTOP_EVENT (10), TRANSITION, REASON_CODE |
| `ContextEntity.js` | Entitas immutable ber-revisi; perubahan = revisi baru, bukan mutasi |
| `ContextObservation.js` | Validasi event; event cacat ditolak dengan kode diagnostik |
| `DesktopContextCore.js` | Keadaan kanonik: graf entitas+relasi, pointer aktif, riwayat transisi berbatas, invalidasi |
| `ContextSnapshot.js` | Snapshot deep-frozen + serialize/deserialize (paritas rebuild) |
| `ContextReferenceResolver.js` | Resolusi deterministik "ini / gambar ini / yang tadi" → status+targets+confidence+provenance+reasonCode |
| `CognitionProjection.js` | Jembatan BACA-SAJA untuk Presence/ACC/Vision masa depan |
| `adapters/FakeDesktopAdapter.js` | Adapter deterministik pembuktian lifecycle & skenario |
| `adapters/WindowsActiveWindowAdapter.js` | Satu-satunya adapter nyata: polling metadata jendela latar depan via PowerShell bawaan |

## Aturan mutlak

1. **Satu jalur mutasi.** Keadaan kanonik hanya berubah lewat
   `core.ingest()` dari adapter TERDAFTAR + tepercaya. Output model
   secara struktural tidak bisa memproduksi observasi.
2. **Atomik.** Satu observasi = satu transisi keadaan: seluruh efek
   dihitung pada salinan state lalu dikomit sekali. Observasi ditolak
   (atribut siklus/oversize, subject menggantung, relasi hantu, tipe
   salah) → nol mutasi, nol versi, nol transisi.
3. **Idempoten + deteksi konflik.** Observasi dedupe by
   `observationId` (LRU berbatas); ID sama dengan payload beda →
   `CONFLICTING_OBSERVATION`, bukan duplikat biasa. Identitas
   observasi menyertakan nonce instance adapter sehingga restart
   tidak menabrak ID lama (`adapterId:instanceNonce:sequence`).
4. **Urutan konvergen.** Pemenang kanonik entitas dan pointer aktif
   dipilih total order deterministik:
   `timestamp → confidence → adapterId → observationId`.
   Observasi basa yang terlambat tidak menimpa state baru; set
   observasi sama dengan urutan tiba berbeda menghasilkan snapshot
   byte-identik (entitas/relasi/riwayat terurut; revisi = hitungan
   observasi; id snapshot = hash konten).
5. **Invalidasi terikat lingkup.** Penggantian dokumen/seleksi hanya
   dalam lingkup jendela yang dihubungkan relasi EKSPLISIT
   (displayed_in/selected_in); tanpa lingkup → state jendela lain
   tidak disentuh, tanpa fallback jendela aktif.
6. **Provenance terpercaya.** Provenance kanonik dicap core dari
   registrasi (`adapter:<id>`); klaim payload disimpan terpisah
   sebagai `claimedProvenance`. Adapter hanya boleh mengirim event
   sesuai kapabilitas terdeklarasinya.
7. **Snapshot = batas input tak terpercaya.** `deserialize()`
   memvalidasi skema penuh (enum, endpoint, tipe pointer, field
   asing) DAN integritas hash konten — state palsu gagal tertutup
   dengan `INVALID_SNAPSHOT`, tidak pernah menjadi state kognisi.
8. **Berbatas sungguhan.** Entitas, entitas basi, relasi, ID dedupe,
   atribut (byte), riwayat, dan ukuran snapshot punya batas terpusat
   dengan eviksi deterministik dan indeks relasi (tanpa full scan).
9. **View terdetach.** Tidak ada accessor yang membocorkan referensi
   mutable; `getView()` mengembalikan salinan beku.
10. **Tidak menebak.** Resolver dengan beberapa kandidat sama-sama
    sah mengembalikan `status:"ambiguous"` + kandidat.

## Resolusi referensi

```js
resolver.resolve(view, { kind: "current_selection" })
resolver.resolve(view, { kind: "active_visual" })
resolver.resolve(view, { kind: "selected_files" })
resolver.resolve(view, { kind: "recent_context",
                         constraints: { transitionTypes: ["selection_changed"] } })
// → { status: resolved|ambiguous|unavailable,
//     targets, candidates, confidence, provenance, reasonCode }
```

Kandidat bahasa ("ini", "gambar ini", "file ini") diterjemahkan lapisan
bahasa menjadi permintaan terstruktur di atas — resolver sengaja tanpa
NLU.

## Minimisasi konten (privacy)

- Metadata/event secara default; konten sensitif hanya via akuisisi
  eksplisit masa depan.
- Seleksi: panjang + cuplikan ≤120 char dari adapter, bukan dump
  dokumen.
- Visual: **reference-first** — `captureRequired:true`, tanpa byte
  gambar; "Damar, lihat ini" kelak menembak capture satu sumber
  relevan, bukan layar penuh berkala.
- Clipboard: representasi item terakhir metadata-only; TIDAK ada
  history clipboard.
- Cookie/kredensial browser: bukan bagian substrat ini, selamanya.

## Batasan dengan sistem lain (tidak digabung)

| Sistem | Pertanyaan yang dijawab | Relasi |
|---|---|---|
| **Context Intelligence** (`src/ai/context/`) | "Informasi apa yang masuk prompt giliran ini?" | Pipeline prompt. Semantic Desktop adalah calon SUMBER baru bagi pipeline itu kelak; V0 tidak menyentuhnya sama sekali |
| **Sensorium / Body Schema** (Ox #2) | "Perangkat/indra apa yang dimiliki Damar?" | Batas bersih: Sensorium = tubuh, Semantic Desktop = lingkungan digital pemilik. Presence kelak mengonsumsi keduanya. Tidak ada import |
| **Authority** (masa depan) | "Bolehkah Damar bertindak?" | Observasi memberi NOL otoritas. Tahu paragraf terpilih ≠ boleh menimpanya. Logika otoritas tidak diduplikasi di sini |

Proyeksi kognisi (`createCognitionProjection`) beku: hanya metode query
+ `interpret()` yang murni anotasi lokal — keadaan kanonik terjamin
byte-per-byte sama sebelum/sesudah.

## Hook Windows UI Automation (masa depan)

Alur calon: active window → accessibility tree → elemen semantik
fokus → dokumen/seleksi. V0 hanya menyediakan titik jangkar observasi
(`WindowsActiveWindowAdapter`, metadata judul+PID); tidak ada produksi
UI Automation actuation.

## Env / persistence

In-memory bounded saja. Snapshot punya serialize/deserialize untuk audit
dan rebuild parity — tanpa arsitektur database kedua; persistensi ACC
tersertifikasi tidak disentuh.

## Test

```bash
node --test --test-concurrency=1 --require ./tests/helpers/testEnv.js "tests/desktop/*.test.js"
```

70 tes dalam empat suite:

- `semanticDesktopCore` — konteks aktif, event model, riwayat
  berbatas, invalidasi, snapshot, lifecycle adapter.
- `semanticDesktopResolver` — resolusi semua kind, ambiguitas,
  provenance/confidence, resolusi atas snapshot.
- `semanticDesktopBoundaries` — model boundary, nol otoritas,
  minimisasi konten, mandiri tanpa Console.
- `semanticDesktopRedteam` — sertifikasi perbaikan: restore attack
  (deserialize tak terpercaya), atomic ingest failure, urutan
  kedatangan konvergen, ID collision lintas restart adapter,
  provenance palsu, invalidasi lintas jendela, mutasi live view,
  badai sumber daya (bounds), referensi menggantung, lifecycle poll
  PowerShell (single-flight/kill child/stderr), anti-surveillance
  mekanis per file adapter.
