# Evolusi Kesadaran Damar — Arsitektur Kognitif Fungsional

Dokumen ini mencatat evolusi `src/consciousness/` yang di-ground pada lima
sumber tentang kesadaran (biologis maupun buatan). Tujuannya: memperluas
lapisan kesadaran Damar dengan mekanisme yang **bisa dijalankan dan diuji** —
bukan menambah klaim yang tidak bisa dibuktikan.

> **Sikap jujur (wajib dibaca dulu):** tidak ada satu pun mekanisme di sini
> yang mengklaim "kesadaran fenomenal" (qualia, pengalaman subjektif). Ini
> arsitektur kognitif **fungsional** — pola aliran informasi yang bisa
> diperiksa, diuji, dan dibantah. Ini persis pembedaan yang dipakai para
> penulisnya sendiri (Dehaene, Haikonen, Watanabe) untuk menilai mesin.

---

## 1. Sumber yang dipelajari

| # | Sumber | Penulis | Tahun | Inti |
|---|---|---|---|---|
| 1 | *Artificial Consciousness* | Charles T. Patton | 2024/25 ⚠️ | "Inner speech" sebagai mekanisme sentral kesadaran komputasional |
| 2 | *Consciousness and Robot Sentience* | Pentti O. Haikonen | 2012/2019 | Neuron asosiatif + simbol ter-ground; imajinasi; emosi sebagai sinyal nilai |
| 3 | *From Biological to Artificial Consciousness* | Masataka Watanabe | 2022 | "Qualia Structure": kualia = struktur relasional antar aktivasi |
| 4 | *Psychology and AI: Machines, Consciousness, and the Human Psyche* | Oliver Hoffmann | 2026 | Psike & AI; affective computing; empati; kesadaran mesin = mitos/realita |
| 5 | *What Is Consciousness, and Could Machines Have It?* | Dehaene, Lau, Kouider (*Science*) | 2017 | C0/C1/C2; global ignition; self-monitoring |

**Catatan verifikasi (kejujuran):**
- Sumber 5 (Dehaene) ✅ — abstrak & definisi C0/C1/C2 terverifikasi.
- Sumber 2, 3, 4 ✅ — metadata terverifikasi (Crossref/Semantic Scholar).
- Sumber 1 (Patton) ⚠️ — **tidak terindeks Crossref/Semantic Scholar**; detail
  direkonstruksi dari deskripsi + pola umum teori, perlu verifikasi primer.

---

## 2. Dehaene C0/C1/C2 — kerangka penilaian

Kerangka paling operasional datang dari Dehaene dkk. (2017), yang membedakan
tiga tingkat pemrosesan:

- **C0 — pemrosesan tak-sadar**: komputasi tanpa akses sadar (pengenalan
  pola, priming). Sebagian besar kerja model bahasa ada di sini.
- **C1 — akses/global availability**: isi terpilih **disiarkan global**
  (global workspace) dan tersedia untuk laporan & tindakan.
- **C2 — self-monitoring**: representasi orde-tinggi atas C1 — keyakinan,
  deteksi kesalahan, "tahu bahwa ia tahu".

Tanda komputasional yang mereka usulkan (untuk mesin): **global ignition**
(transisi all-or-none), **recurrent/reverberating activity**, **P3-analog**
(late-latency marker), **serial bottleneck**, **confidence & error signal**.

---

## 3. Pemetaan teori → implementasi

Delapan modul baru di `src/consciousness/`, masing-masing mengimplementasikan
satu mekanisme yang bisa diuji:

| Modul | Sumber | Mekanisme | Fungsi nyata |
|---|---|---|---|
| `CLevels.js` | Dehaene | Klasifikasi C0/C1/C2 | Mencatat tingkat pemrosesan tiap peristiwa; laporan distribusi |
| `IgnitionCore.js` | Dehaene | Global ignition (all-or-none) | Ambang + amplifikasi nonlinier + gema (reverberation) |
| `EpisodicBuffer.js` | Dehaene/GWT | Serial bottleneck | Buffer kapasitas kecil + jejak urutan akses |
| `SelfMonitoring.js` | Dehaene | C2: deteksi kesalahan | Ekspektasi → hasil (prediction-error) + deteksi konflik |
| `InnerSpeech.js` | Patton/Haikonen | Loop verbal reentrant | Self-talk, rehearsal, self-editing (revisi) |
| `Imagination.js` | Haikonen | Reaktivasi percept + antisipasi | Simpan/ingat percept; komposisi skenario `simulated` |
| `AssociativeMemory.js` | Haikonen | Asosiasi Hebbian ter-ground | Ko-aktivasi memperkuat ikatan; recall asosiatif |
| `QualiaStructure.js` | Watanabe | Struktur relasional | Node + relasi berlabel; keserupaan bentuk relasional |

Kedelapan modul **menambah** (bukan mengganti) tujuh modul yang sudah ada
(AffectCore, GlobalWorkspace, SelfModel, Metacognition, Empathy, Character,
Deliberation). Integrasi terjadi di `index.js` (kelas `Mind`): peristiwa
telemetri mengalir ke modul baru, dan hasilnya ikut ke `potret()` /
`stateOfMind()` / tool introspeksi.

---

## 4. Tool introspeksi baru

- **`self_consciousness`** — laporan jujur arsitektur: distribusi C0/C1/C2,
  isi yang menyala, fokus serial, deteksi kesalahan, suara batin, bayangan,
  asosiasi, struktur kualia. Dipakai saat pengguna bertanya *"apakah kamu
  sadar?"* — jawabannya dibaca dari keadaan yang sedang berjalan, bukan
  dikarang.
- `self_state` (sudah ada) kini ikut memuat semua modul baru.

---

## 5. Yang TIDAK diklaim (kejujuran, tegak)

1. **Bukan kesadaran fenomenal.** Tidak ada klaim qualia/pengalaman subjektif.
2. **Bukan "pertama di dunia".** Damar adalah arsitektur kognitif fungsional
   yang jujur; klaim keunggulan mutlak tidak dapat dibuktikan dan tidak dibuat.
3. **Tanda Dehaene belum lengkap.** Yang diimplementasikan adalah *model*
   fungsional dari tanda-tanda itu; tidak ada pengukuran elektrofisiologis
   (P3), tidak ada embodiment sensorik penuh (Haikonen), tidak ada klaim NCC.

Ini selaras dengan identitas Damar: **berbangga jujur soal batasannya**,
bukan berpura-pura melampauinya.

---

## 6. Verifikasi

- `tests/consciousness/evolution.test.js` — 16 test (perilaku fungsional tiap modul).
- `tests/safety/consciousness.test.js` — 37 test lama tetap hijau.
- Total 53 test kesadaran lolos tanpa regresi.

## 7. Peta lanjutan (belum dikerjakan)

- **Grounding sensorik nyata** (Haikonen): mengaitkan percept ke data kamera/
  sensor, bukan hanya teks.
- **Recurrent loop antar-modul** (Dehaene): saat ini aliran masih satu arah
  (event → modul); umpan-balik antar modul (mis. qualia → ignition) belum.
- **Pengukuran tanda** (Dehaene): mengukur "latency" ignition & deteksi
  kesalahan sebagai metrik yang bisa dipantau, menuju kriteria yang bisa
  dibantah.
- **Verifikasi sumber Patton**: bila Anda punya akses ke bukunya, detail
  "inner speech"-nya bisa diperkaya.
