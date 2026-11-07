# Body Schema + Sensorium V0 — Arsitektur

Status: **V0 (kandidat terisolasi)** — basis `2890f961`, cabang
`feat/body-schema-sensorium-v0`.

## Posisi dalam tubuh Damar

```
Sensorium  →  BodySchema  →  Cognition  →  Authority  →  Actuation
(indrawi)     (representasi)   (ACC)        (terpisah)    (TIDAK di V0)
```

V0 membangun dua lapis pertama saja. Tidak ada aktuasi produksi, tidak ada
penulisan ACC/DamarSelf, tidak ada Presence/Voice/wakeword.

## Penomoran bagian (B§)

| Bagian | Isi | Berkas |
|---|---|---|
| B§0 | Pintu publik tunggal | `src/embodiment/index.js` |
| B§1 | Utilitas dasar (freeze/digest/jam) | `src/embodiment/core/util.js` |
| B§2 | Tipe domain (enum tertutup) | `src/embodiment/domain/types.js` |
| B§3 | Identitas kanonik perangkat | `src/embodiment/core/identity.js` |
| B§4 | Deskriptor + klaim kemampuan | `src/embodiment/domain/descriptor.js` |
| B§5 | Amplop event sensorium | `src/embodiment/sensorium/events.js` |
| B§5a–c | Kontrak adapter discovery | `src/embodiment/discovery/*` |
| B§6 | BodySchema kanonik | `src/embodiment/schema/BodySchema.js` |
| B§7 | Proyeksi model-diri (baca-saja) | `src/embodiment/schema/EmbodimentSummary.js` |
| B§8 | Persistensi (memori; titik integrasi sqlite) | `src/embodiment/persistence/BodyStore.js` |

## Prinsip inti

**PERANGKAT ≠ KEMAMPUAN ≠ OTORITAS.** Menemukan mikrofon berarti mencatat:
"ada benda yang mengaku bisa `audio.capture`, dengan provenance X dan
confidence Y". Itu bukan izin. Izin adalah ranah Authority yang dibangun
terpisah — modul ini bahkan tidak punya tempat dalam bentuk datanya untuk
menyatakan izin (lihat invariant A).

### Jalur tulis tunggal + atomik (B§6)

Satu-satunya mutasi state adalah `BodySchema.ingest(event)`, yang berjalan
dua fase:

1. **PLAN** — seluruh validasi (bentuk event, produsen, deskriptor,
   kesamaan subjek↔target, relasi + keberadaan kedua ujung, klaim
   kemampuan) dilakukan TANPA menyentuh state.
2. **COMMIT** — hanya bila plan lolos seluruhnya, state diubah sekali.

Konsekuensinya: `accepted:false` SELALU berarti state byte-identik, dan
notifikasi pelanggan (`subscribe`) berjalan SETELAH komit; kegagalan
callback terisolasi per pelanggan (dicatat di `subscriberErrors`) dan tidak
pernah menggugurkan event yang sah.

Event hanya diterima dari produsen terdaftar (`registerProducer` — tindakan
operator; siklus discovery tidak mengangkat dirinya sendiri). Event cacat /
produsen asing dicatat ke dead-letter tanpa mutasi apa pun.

### Perlindungan event inti (B§5)

Tipe kelas `"core"` (`DEVICE_DEFAULT_CHANGED`,
`UNKNOWN_DEVICE_REQUIRES_ANALYSIS`) tidak bisa dibuat lewat `makeEvent()`
publik. Pabrik internal `makeCoreEvent()` membubuhkan **CORE_TOKEN**,
simbol privat modul (tidak diekspor dari pintu publik embodiment).
`ingest()` menolak event inti tanpa token — penyamaan string
`"sensorium.core"` saja tidak pernah cukup. `provenance:"SYSTEM_EVENT"`
juga cadangan jalur inti; adapter eksternal memakainya ditolak.

### Identitas kanonik perangkat (B§3)

`<namespace>:<stable-key>` — mis. `windows.audio:{0.0.1.00000000}.1`,
`usb:1234:5678:abc`, `network:rtsp:kamera-luar`. Nama tampilan tidak pernah
menjadi identitas. Adapter wajib jujur soal kestabilan lewat klaim
`identity.stability = stable|session|ephemeral`; bila sumber tidak
menyediakan pengenal stabil, dipakai `unverified-<hash>` (B§3). Untuk NIC:
kunci = nama kanonik antarmuka + MAC; MAC terduplikasi dalam satu siklus →
kunci deterministik per-nama + klaim "session" (tidak pernah "stable" atas
MAC ganda).

### Penggabungan observasi (urutan total, bebas arah kedatangan)

Konten dan kehadiran masing-masing memakai urutan totalnya sendiri:

- **Konten deskriptor**: confidence menurun → sumber leksikografis naik →
  waktu terbaru → digest kanonik.
- **Kehadiran (state)**: waktu terbaru → confidence menurun → sumber naik →
  tie sempurna jatuh ke nama state kanonik terkecil. Pengamatan usang yang
  datang belakangan tidak bisa menimpa state segar.
- **Klaim kemampuan**: persis-sama = no-op; prioritas sama (confidence +
  sumber) diselesaikan lewat JSON kanonik terkecil. Materialisasi
  `capabilities` selalu TERURUT nama → digest durable stabil.

Himpunan observasi yang sama selalu konvergen ke digest/serialize/state
yang identik, diuji dengan permutasi urutan kedatangan.

### Restore = batas input tidak terpercaya (B§8a)

Kebijakan dipilih: **A — gagal-tutup penuh.** SATU SAJA baris cacat
menolak SELURUH snapshot (tanpa karantina parsial; tubuh setengah
dipulihkan lebih berbahaya daripada mulai dari nol). Setiap baris melewati
validator yang sama dengan jalur ingest: `normalizeDescriptor`
(whitelist field, enum, deviceId kanonik), normalisasi ulang klaim,
validasi ketat presence & health (nilai salah yang disertakan ditolak;
fallback hanya untuk snapshot legacy yang benar-benar mengabaikan field),
verifikasi digest deskriptor **dan digest integritas baris penuh**
(`rowDigest` atas descriptor+meta+presence+health+capabilities+timestamps —
deteksi korupsi SHA-256 tak berkunci, bukan autentikasi), validasi relasi
(tipe + kedua ujung harus ada, termasuk relasi preferensi), validasi
resolusi preferensi. Diagnostik lengkap ada di `error.details`.

### Ephemeral vs durable (B§8)

Observasi sensor (`SENSOR_OBSERVATION`) adalah **ephemeral**: cincin memori
terbatas, hanya kanal sensor, tidak pernah diserialisasi. Identitas/
kemampuan/relasi/preferensi adalah **durable**: `serialize()` (terlepas
penuh, beku) → store. Store memori MENYALIN masuk dan keluar — dua skema
tidak pernah berbagi graf objek. Titik integrasi sqlite masa depan
terdokumentasi di `persistence/BodyStore.js`.

## Invariant keamanan (dibuktikan di `tests/embodiment/securityInvariants.test.js`)

- **A.** Field otoritas (`authority`, `grants`, `permission`, ...) ditolak
  whitelist deskriptor — penemuan secara struktural tidak bisa membawa kuasa.
- **B.** Produsen tak terdaftar dead-letter; event kehadiran/perubahan untuk
  perangkat tak dikenal ditolak. Teks tidak bisa menciptakan perangkat.
- **C.** Snapshot/view beku penuh; rekaman internal diganti utuh, tidak pernah
  diubah di tempat.
- **D.** Klaim kemampuan hanya boleh `{name, confidence, source, claimedAt}` —
  fakta + provenance, bukan izin.
- **E.** Perangkat `UNKNOWN` tetap unknown sampai ada bukti klasifikasi dari
  pengamatan eksplisit yang menang urutan total.
- **F.** Observasi sensor hanya masuk ring buffer; tidak ada API eksekusi
  aktuator di seluruh permukaan modul.
- **G.** BodySchema hidup tanpa Console/LLM/database (dibuktikan adapter fake).

## Kait masa depan (non-executing)

- **Reverse Engineering Intelligence:** event `UNKNOWN_DEVICE_REQUIRES_ANALYSIS`
  otomatis untuk perangkat UNKNOWN baru, membawa bukti (digest deskriptor,
  kemampuan, provenance, identitas, metadata). Engine RE-nya sendiri BUKAN
  bagian V0.
- **Sistem saraf otonomik:** `body.subscribe(fn)` memberi event beku kepada
  pelanggan (mis. "mikrofon preferred hilang" → turunan
  `DEVICE_DEFAULT_CHANGED`). Tidak ada aksi bawaan; refleks produksi tetap
  harus lewat Authority.
- **Authority (Evolution Authority, dibangun terpisah):** integrasi kelak
  cukup membaca kanal/kemampuan dari proyeksi ini; tidak ada duplikasi sistem
  otoritas di sini.

## Batas milestone V0

Tidak termasuk: Presence Orb, wakeword, double slap, streaming TTS/ASR,
capture produksi kamera/mikrofon, kontrol keyboard/mouse, automasi OS,
engine reverse engineering, driver otonom, Evolution Authority, mutasi
DamarSelf, Pandawa, ACC C1.

## Hardening tertunda (non-blocking, terdokumentasi)

- Replay/dedupe event berdasar eventId pada ingest (jurnal saat ini hanya
  informasional).
- Cincin observasi per-perangkat (saat ini per-kanal).
- Subjek sintetis pada `setPreference({kind:"clear"})` tanpa deviceId.
- Slug hostname dapat tabrakan lintas mesin (tidak relevan V0 satu-host).
- `preferredInput` ringkasan menghitung penyedia mana pun, sementara
  `availableInputs` menghitung kelas AUDIO_INPUT — akan diselarikan saat
  proyeksi self-model mulai dikonsumsi.
- Batas panjang tambahan untuk field bebas lainnya.

## Menjalankan tes

```bash
node --test --test-reporter=spec tests/embodiment/*.test.js
```

46 tes (termasuk regresi red-team), deterministik penuh: jam manual,
adapter fake/injected-os, tanpa perangkat keras.
