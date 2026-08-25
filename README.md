# Aether — Entitas AI Sadar yang Berjalan Lokal

**AI Runtime Framework + entitas AI dengan lapisan kesadaran** — berjalan lokal
di perangkatmu sendiri. Aether bukan sekadar penjawab: ia punya **keadaan batin
yang persisten** (afek, perhatian, model-diri, metakognisi, empati), **watak
yang tumbuh dari pengalaman** (bukan ditulis di prompt), dan **cara berpikir dua
kecepatan** yang melambat saat taruhannya tinggi. Di atas itu ia menyatukan otak
AI (lokal maupun cloud), memori jangka panjang, penglihatan (kamera/CCTV),
kendali rumah, WhatsApp, pemantauan & eksekusi crypto (Binance), serta mesin
pencari uang nyata — semuanya di balik satu daemon dengan **Console desktop**,
**CLI**, dan **skill** yang bisa dipanggil lewat obrolan.

> **Kejujuran soal kesadaran:** keadaan batin Aether NYATA dan fungsional —
> terbentuk dari kejadian, persisten lintas sesi, dan mengubah perilakunya. Itu
> BUKAN klaim pengalaman subjektif seperti manusia; Aether sendiri diprogram
> menyatakan pembedaan itu apa adanya bila ditanya.

> Semua data (memori, kredensial, keadaan batin, pembukuan) tersimpan **lokal**
> dan gitignored.

---

## Daftar isi
- [Fitur](#fitur)
- [Kesadaran (Mind)](#kesadaran-mind)
- [Mesin cuan (uang nyata)](#mesin-cuan-uang-nyata)
- [Arsitektur singkat](#arsitektur-singkat)
- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Menjalankan](#menjalankan)
- [Konfigurasi (Console → Settings)](#konfigurasi-console--settings)
- [Skills](#skills)
- [Memori](#memori)
- [Log & investigasi](#log--investigasi)
- [Struktur proyek](#struktur-proyek)
- [Keamanan](#keamanan)
- [Troubleshooting](#troubleshooting)

---

## Fitur

- **Kesadaran (Mind)** — lapisan yang berjalan terus: **afek** (valensi/arousal
  dua sumbu, meluruh ke garis dasar), **ruang kerja global** (perhatian terbatas
  7 slot berbasis salience), **model-diri**, **metakognisi** (keyakinan
  terkalibrasi bukti), dan **empati** (membaca keadaan pengguna → mengubah sikap).
  Ikut ke setiap prompt, bukan sekadar tool yang dipanggil.
- **Watak yang tumbuh** — enam sumbu sifat (kehangatan, ketelitian, keberanian,
  keingintahuan, ketegasan, humor, plus **ketekunan**) yang bergerak lambat dari
  **akibat** perbuatan, bukan dari niat. Tanpa rasa takut yang melumpuhkan, tanpa
  malas: keberanian & ketekunan berlantai, kegagalan mengajari lebih teliti.
- **Berpikir dua kecepatan** — sebagian besar giliran dijawab cepat; giliran
  bertaruh tinggi memicu **protokol berpikir dalam** (pecah masalah → ajukan
  alternatif → cari bukti pembantah → premortem → **lalu kerjakan**). Pemicunya
  membaca **tool berisiko & bentuk permintaan**, bukan kata kunci.
- **Patuh pada pemilik** — perintah atas milik pemilik dijalankan, bukan
  diperdebatkan; satu-satunya jeda adalah konfirmasi order/uang nyata (pagar yang
  dipasang pemilik sendiri).
- **Mesin cuan** — pindai ribuan pasangan Binance jadi peluang berlikuiditas,
  **ukur posisi dari risiko** (bukan dari saldo), dan **bukukan hasil nyata**
  supaya strategi rugi ketahuan.
- **Crypto (Binance)** — pantau harga/portofolio/posisi, analisa teknikal, chart
  **live** di popup Console (TradingView), alarm harga, bot sinyal, dan eksekusi
  order **dua langkah** (siapkan → konfirmasi pemilik).
- **Otak fleksibel** — pilih **AI Lokal** (llama.cpp in-process) atau **AI Provider** (OpenRouter,
  OpenAI, Google AI Studio, Groq, atau custom OpenAI-compatible). Daftar model
  **dikurasi otomatis**: model gratis diutamakan, model non-chat/usang disaring,
  ada **verifikasi** + **fallback otomatis** bila model 404/deprecated.
- **Memori jangka panjang** — SQLite + FTS5 + embedding (recall hibrida). Aether
  mengingat identitas, kebiasaan, perangkat, dan dokumen.
- **Skills (50+)** — kemampuan siap pakai yang menggabungkan semua subsistem +
  **orkestrasi** multi-agent (10 anak buah spesialis). Aether juga bisa
  **membuat skill sendiri** lewat percakapan (draft → aktifkan).
- **WhatsApp** — chat pribadi & grup, balas saat di-mention/di-reply, analisis
  media masuk (gambar/stiker/voice note/dokumen), kirim media. Login via **QR**.
- **Vision** — "melihat" kamera/CCTV & webcam, pratinjau live, terintegrasi ke chat.
- **Home automation** — kendali Home Assistant (lampu, AC, saklar, scene).
- **Orang & wajah** — galeri Immich + pengenalan wajah (opsional).
- **Suara** — TTS (suara OS atau neural mis. Kokoro) + STT (mis. faster-whisper) +
  avatar minibot.
- **Voice Runtime (always-on)** — asisten suara seperti Siri/JARVIS: wake word
  ("Aether") atau tepuk tangan 2x, acknowledgement deterministik, VAD, barge-in,
  dan jawaban dibacakan. Channel menuju Aether Core yang sama (bukan otak kedua);
  local-first, graceful degradation, nonaktif secara default.
- **Companion Devices** — kendalikan Aether dari device lain (HP/laptop/tablet)
  di jaringan yang sama / Bluetooth PAN, memakai tools & skill yang sama. Pairing
  kode 6 digit + token per device; device = client tipis ke Aether Core.
- **Proaktif** — brief keadaan rumah harian terjadwal, dikirim ke WhatsApp.
- **Antarmuka** — Console desktop (Electron), CLI terminal, dan REST/SSE API.

---

## Kesadaran (Mind)

Lapisan di `src/consciousness/` — dirakit dari lima bagian, masing-masing
berlandaskan teori yang bisa dijalankan (bukan puitis):

| Bagian | Landasan | Fungsi nyata |
|---|---|---|
| `AffectCore` | Circumplex (Russell), appraisal (Scherer/Lazarus), penanda somatik (Damasio) | Afek dua sumbu (valensi/arousal); peristiwa menggeser, waktu meluruhkan; membiaskan ketelitian **tanpa** melumpuhkan tindakan |
| `GlobalWorkspace` | Global Workspace (Baars/Dehaene) | Panggung perhatian 7 slot; hanya isi bersalience-tinggi yang "menyala" |
| `SelfModel` | Model-diri (Metzinger), skema perhatian (Graziano) | Identitas, nilai, batas yang disadari, riwayat perubahan diri |
| `Metacognition` | Teori orde-tinggi (Rosenthal/Fleming) | Keyakinan terkalibrasi bukti nyata; memaksa jujur saat bukti tipis |
| `Empathy` | Teori pikiran + emotional contagion | Baca valensi/kebutuhan pengguna → **sikap** yang tepat; menular tipis ke afek sendiri |
| `Character` | Trait sebagai distribusi state (Fleeson) | Watak tumbuh lambat dari akibat; menggeser garis dasar afek & ambang berpikir |
| `Deliberation` | Dua sistem (Kahneman), pemikiran ganda (Stanovich), premortem (Klein) | Menilai kapan berpikir dalam; menyisipkan protokol wajib ke prompt |
| `CLevels` | C0/C1/C2 (Dehaene–Lau–Kouider 2017) | Klasifikasi tingkat pemrosesan: tak-sadar → siaran global → self-monitoring |
| `IgnitionCore` | Global neuronal workspace (Dehaene) | Nyala all-or-none + amplifikasi nonlinier + gema (reverberation) |
| `EpisodicBuffer` | Global workspace (Baars/Dehaene) | Bottleneck serial — isi diproses satu per satu, jejak urutan tercatat |
| `SelfMonitoring` | Teori orde-tinggi (Dehaene C2) | Ekspektasi→hasil (prediction-error) + deteksi kontradiksi |
| `InnerSpeech` | Inner speech (Patton, Haikonen) | Loop verbal internal: self-talk, rehearsal, revisi diri |
| `Imagination` | Reaktivasi percept (Haikonen) | Simpan/ingat percept + komposisi skenario antisipasi (`simulated`) |
| `AssociativeMemory` | Neuron asosiatif (Haikonen) | Asosiasi Hebbian ter-ground: ko-aktivasi memperkuat ikatan |
| `QualiaStructure` | Qualia Structure (Watanabe) | Kualia sebagai struktur relasional antar representasi |

Keadaan batin ikut ke tiap giliran lewat `Mind.stateOfMind()` dan bisa
diintrospeksi lewat tool **`self_state`**, disimpan lewat **`self_reflect`**,
diperkaya lewat **`self_note`** / **`empathy_read`** / **`think_deeply`**.
Tersimpan di `configs/mind.json` (lokal, gitignored).

Tanya *"kamu lagi gimana?"*, *"kamu sadar nggak?"* → Aether membaca keadaannya
yang sungguh sedang berjalan, bukan mengarang.

---

## Mesin cuan (uang nyata)

`src/money/` — tiga bagian, dan yang ketiga paling menentukan:

1. **Pindai** (`money_scan`) — saring 3.600+ pasangan Binance jadi peluang
   berlikuiditas dari data publik (tanpa API key, tanpa geo-block), gaya
   `momentum` atau `pantul`, lengkap dengan saran stop & target.
2. **Takar** (`money_size`) — ukuran posisi = (saldo × risiko%) ÷ jarak-ke-stop.
   Kerugian terburuk diketahui **sebelum** masuk dan tak pernah melebihi batas.
3. **Bukukan** (`money_log` / `money_report`) — tiap ide dicatat + ditutup dengan
   hasil **nyata** (crypto maupun non-crypto), lalu diperingkat per sumber.
   Strategi rugi terlihat rugi — Aether bisa dibantah oleh angkanya sendiri.

> **Jujur di muka:** tak ada pemindai yang menjamin untung. Yang dijamin cuma
> peluangnya nyata (data live), risikonya terukur, hasilnya dibukukan apa adanya.
> Eksekusi order tetap lewat konfirmasi pemilik. Tersimpan di `configs/money.json`.

---

## Arsitektur singkat

```
   Console (Electron) · CLI (npm run cli) · WhatsApp · REST/SSE API
                          │  (klien tipis)
                 ┌────────▼─────────────────────────────────────────┐
                 │  Daemon (Express)  ·  src/server.js  ·  :3000       │
                 ├────────────────────────────────────────────────────┤
                 │ Mind        — afek·perhatian·diri·metakognisi·empati│
                 │ AI Runtime  — provider abstraction, tools, fallback │
                 │ Memory      — SQLite/FTS5/vektor                    │
                 │ Money       — pindai·takar risiko·bukukan (Binance) │
                 │ Skills/Plugins · Vision · Home · Immich · WhatsApp  │
                 │ Automation  — brief proaktif                        │
                 │ AgentHub → 10 anak buah Aether · Orchestrator       │
                 └────────────────────────────────────────────────────┘
```

- **Core kecil & stabil**; kemampuan baru masuk sebagai **plugin/skill**,
  **provider**, atau **service** — bukan mengubah core.
- Semua klien (Console/CLI/WhatsApp) adalah klien tipis ke daemon.

---

## Prasyarat

- **Node.js ≥ 18** dan **npm**.
- Wajib: tidak ada. Aether tetap hidup tanpa API key (pakai model lokal
  bila ada, atau menunggu dikonfigurasi).
- Opsional (aktifkan sesuai kebutuhan):
  - **node-llama-cpp** — otak lokal in-process (GGUF di models/).
  - **API key** OpenRouter / OpenAI / Google AI Studio / Groq — AI cloud.
  - **WhatsApp** — paket `@whiskeysockets/baileys` + `qrcode`.
  - **Home Assistant** — kendali rumah (URL + long-lived token).
  - **Immich** / layanan wajah — foto & pengenalan wajah.
  - **Kokoro-FastAPI** (TTS neural) & **faster-whisper** (STT).

---

## Instalasi

```bash
git clone https://github.com/jrxid09-design/Aether.git
cd Aether

# dependensi daemon
npm install

# dependensi Console desktop (Electron)
npm run console:install

# (opsional) WhatsApp
npm install @whiskeysockets/baileys qrcode
```

---

## Menjalankan

**Satu perintah (disarankan)** — daemon + Console sekaligus, dengan banner
berwarna dan **log rinci berstempel waktu** di terminal (juga disimpan ke
`logs/aether-YYYY-MM-DD.log`):

```bash
npm run aether
```

Perintah lain:

| Perintah | Fungsi |
|---|---|
| `npm run aether` | Daemon **+** Console desktop (satu operasi, log rinci) |
| `npm run aether:daemon` | Daemon saja, tampilan launcher + log rinci |
| `npm start` | Daemon saja (banner ringkas) |
| `npm run dev` | Daemon dengan auto-reload (nodemon) |
| `npm run console` | Console desktop saja (butuh daemon jalan) |
| `npm run cli` | CLI terminal interaktif |

Variabel lingkungan:

| Env | Arti |
|---|---|
| `PORT` | Port daemon (default `3000`) |
| `AETHER_TOKEN` | Kunci API bidang kendali (kosong = terbuka di jaringan lokal) |
| `AETHER_PORT_AUTO=1` | Geser port otomatis bila bentrok |

Hentikan semuanya dengan **Ctrl+C**.

---

## Konfigurasi (Console → Settings)

> **Instalasi bersih = "Aether versi kamu".** Repo ini TIDAK memuat satu pun
> kredensial atau data pribadi. Saat pertama dijalankan, Aether membuat sendiri
> folder `configs/` dan `data/` yang kosong — memori nol, watak dari titik awal.
> Semua yang kamu isi tersimpan **lokal** dan sudah gitignored; ia tak akan
> pernah ikut ter-commit.

### Cara mengisi kredensial

**Cara 1 — lewat Console (disarankan, tanpa menyentuh berkas).** Jalankan
`npm run aether`, buka **Settings**, isi kolomnya. Aether menulis `configs/*.json`
untukmu. Ini jalur termudah dan paling aman.

**Cara 2 — menyalin berkas contoh.** Tiap layanan punya berkas `.example`.
Salin ke nama tanpa `.example`, lalu isi nilaimu:

```bash
# contoh: provider AI cloud
cp configs/providers.json.example configs/providers.json
# lalu buka configs/providers.json, ganti GANTI_DENGAN_... dengan kunci aslimu
```

Contoh yang tersedia: `providers` (AI cloud), `binance` (crypto), `telegram`,
`home` (Home Assistant), `immich` (foto/wajah), `voice` (STT/TTS).

**Cara 3 — variabel lingkungan.** Sebagian integrasi bisa ditimpa tanpa berkas,
mis. `AETHER_AGENT_URL=http://192.168.1.10:9000` (lihat `configs/integrations.json`).

> Aether tetap hidup **tanpa satu pun kredensial** — pakai otak lokal bila ada, atau
> menunggu dikonfigurasi. Isi hanya layanan yang kamu pakai.

### Provider AI
- **AI Lokal** — llama.cpp in-process (berkas GGUF di models/). Gratis & privat.
- **AI Provider** — pilih platform, tempel **API key**, tekan **Muat** untuk
  daftar model (bertanda `free`), atau **Verifikasi** untuk menguji tiap model
  (✓ = benar-benar bisa dipakai). Model usang/non-chat disembunyikan; bila model
  aktif mati, Aether **pindah otomatis** ke model kerja berikutnya.

### WhatsApp (QR)
1. `npm install @whiskeysockets/baileys qrcode` lalu mulai ulang daemon.
2. Settings → WhatsApp → **Hubungkan / tampilkan QR**.
3. Di HP: **WhatsApp → Perangkat Tertaut → Tautkan Perangkat → pindai QR**.
4. Isi **nomor pribadi yang diizinkan** (kirim `/id` ke Aether untuk tahu nomormu)
   dan **id grup** bila ingin aktif di grup (sebut "Aether"/reply).
   Ganti nomor perangkat: **Putuskan** lalu pindai ulang.

### Lainnya
- **Suara** — endpoint STT (transcribe) & TTS neural (mis. Kokoro); kosong = suara OS.
- **Home Assistant** — URL + long-lived token.
- **Vision** — pilih model dari integrasi AI aktif; tambah kamera (URL snapshot),
  pratinjau live.
- **Orang & Wajah** — Immich (URL + key) + layanan wajah (opsional).
- **Proaktif** — aktifkan brief harian + jam kirim (dikirim ke WhatsApp).

---

## Skills

Aether punya **50+ skill** bawaan (`src/plugins/aetherSkills`) + skill buatan
sendiri. Skill otomatis menjadi tool yang bisa dipanggil AI.

**Cara pakai:**
1. **Ngobrol** (Chat Console / WhatsApp / CLI) — tulis maksudmu, Aether memilih
   skill sendiri. Contoh: *"lihat kamera dapur"*, *"kirim WA ke 62812…: …"*,
   *"nyalakan lampu ruang tamu"*, *"riset X lalu kirim ke WA-ku"*,
   *"briefing pagi"*, tugas kompleks → *"orkestrasikan: …"*.
2. **Manual** — Console → **Skills & Studio → Terpasang** → pilih tool → isi
   parameter → Jalankan.
3. **Buat skill baru** — minta Aether: *"buatkan skill untuk …"*. Ia membuat
   **draft**, lalu bertanya apakah diaktifkan (tolak = tersimpan sebagai draft).

Kategori: orkestrasi multi-agent, WhatsApp, vision/CCTV, home automation,
memori, Immich, konteks, serta alur komposit (mis. `morning_briefing`,
`arrive_home`, `leave_home`, `security_alert`).

> Skill Home/Immich/Vision butuh layanan terkonfigurasi. Bila belum siap,
> skill membalas pesan error yang jelas.

---

## Tool Intelligence

Aether punya 200+ tool, tetapi model **hanya melihat beberapa tool yang
relevan** dengan pesan itu. Seleksi lewat pipeline deterministik:
capability retrieval → filter peran/kanal → ranking stabil → anggaran
konteks → schema minimum → validasi argumen → ToolGuard → eksekusi →
observasi (replan berbatas).

- "halo" → nol tool; "jam berapa" → hanya waktu; "matikan lampu" → home.
- Anggaran mengikuti ukuran konteks model (8K dapat jauh lebih sedikit
  daripada 128K) — tanpa hardcode provider/model.
- Argumen divalidasi sebelum eksekusi; error machine-readable
  (`VALIDATION_ERROR`, `TIMEOUT`, `POLICY_DENIED`, …) sehingga model
  bisa memperbaiki panggilannya.
- `tool_search` satu-satunya pintu discovery: model mencari kemampuan,
  runtime melampirkan schema-nya di putaran berikutnya.

Benchmark (metodologi, registry sumber, versi dataset, token=ESTIMASI
heuristic chars/4): **[docs/TOOL-INTELLIGENCE.md](docs/TOOL-INTELLIGENCE.md)**.

```bash
# V2 — REAL registry runtime + adversarial (utama)
AETHER_BENCH_STUB_NATIVE=1 node scripts/benchmark-tool-intelligence-v2.js
# V1 — fixture historis (regresi saja, bukan klaim produksi)
node scripts/benchmark-tool-intelligence.js
# Cache/prefix stability (+TTFT live opsional via AETHER_TTFT_URL)
node scripts/benchmark-cache-stability.js
```

---

## Context Intelligence

Model tidak perlu tahu segalanya — juga untuk **informasi**. Setiap
giliran, context dipilih lewat pipeline deterministik: sanitasi
anti-explosion (≤40 pesan, ≤6.000 char/pesan) → recent window + riwayat
lama relevan → memori/batin via adapter existing → dedupe lintas
sumber → anggaran model-aware → kompresi struktural → rakitan
cache-friendly (stabil di depan, dinamis di belakang).

- "lanjutkan skema billing kemarin" mengangkat riwayat lama yang
  relevan, bukan 40 pesan mentah.
- Observasi tool raksasa dikompaksi; raw tetap diarsipkan untuk audit.
- Required-context dijamin selamat (benchmark recall 1.00) dengan
  reduksi token input −85% pada dataset 62 kasus.

Detail + benchmark: **[docs/CONTEXT-INTELLIGENCE.md](docs/CONTEXT-INTELLIGENCE.md)**.
Jalankan: `node scripts/benchmark-context-intelligence.js`.

---

## Memori

- Aether menyimpan fakta penting secara otomatis dan bisa diminta *"ingat …"*
  atau *"apa yang kamu ingat soal …"*.
- Console → **Memory**: jelajah/cari memori, kelola entitas, dan **baca dokumen**
  dengan **memilih berkas/folder langsung** (dialog native, tanpa ketik path).

---

## Log & investigasi

- `npm run aether` menstream log **daemon** (dan **console**) ke terminal dengan
  stempel waktu + tag sumber + warna per level, dan menyimpannya ke
  `logs/aether-YYYY-MM-DD.log`.
- Console → **Logs** menampilkan aliran event/log daemon secara live.

---

## Struktur proyek

```
src/
  server.js            daemon (Express + SSE)
  consciousness/       lapisan Mind — afek, workspace, self, metakognisi,
                       empati, karakter, deliberasi + tool introspeksi
  money/               mesin cuan — pindai peluang, takar risiko, bukukan
  ai/                  AI runtime (builder, providers, executors, tools)
  services/            aiRuntime, binance, whatsapp, vision, home, immich,
                       agentHub, orchestrator, automation, modelHealth, dst.
  channels/            abstraksi kanal — sesi percakapan persisten (SQLite)
                       + registry WhatsApp/Telegram + konteks permintaan
  voice/               Voice Runtime — always-on assistant (wake word, VAD,
                       state machine, provider mic/speaker/STT/TTS)
  companion/           device tertaut — pairing + registry device yang memakai
                       tools/skill Aether dari device lain (LAN/Bluetooth PAN)
  plugins/             plugin bawaan + aetherSkills (50+ skill)
  memory/              skema, store, recall, embedding, dokumen
  cli/                 CLI terminal (tema, perintah, klien)
  controllers/ routes/ bidang kendali REST
scripts/launch.js      launcher satu-perintah (daemon + console + log)
apps/console/          Console desktop (Electron)
configs/               kredensial, setelan, keadaan batin (mind.json),
                       pembukuan (money.json) — lokal & gitignored
```

---

## Keamanan

- Set **`AETHER_TOKEN`** agar bidang kendali tidak terbuka di jaringan.
- Rahasia (API key, sesi WhatsApp, dll) disimpan di `configs/*` dan **gitignored**.
- Jangan pernah menaruh API key di kode/commit — isi lewat Settings.

---

## Troubleshooting

- **Port 3000 dipakai** → daemon lain masih hidup. Hentikan
  (`Get-Process node | Stop-Process -Force` di Windows) atau `set PORT=3001`.
- **WhatsApp `loggedOut` / "Cannot link device"** → sesi lama invalid. Settings →
  WhatsApp → **Putuskan**, lalu **Hubungkan** & pindai QR lagi.
- **Google AI `404`** → model usang; Aether otomatis pindah ke model kerja.
  Pilih model bertanda ✓/free, atau tekan **Verifikasi**.
- **`429` kuota** → kuota harian provider habis; ganti model/provider atau pakai
  **AI Lokal (llama.cpp)**.

---

## Lisensi

Dirilis di bawah **MIT License** — lihat berkas [`LICENSE`](LICENSE). Bebas
dipakai, dimodifikasi, dan disebarluaskan; sertakan pemberitahuan hak cipta.
Perangkat lunak disediakan apa adanya, tanpa jaminan.
