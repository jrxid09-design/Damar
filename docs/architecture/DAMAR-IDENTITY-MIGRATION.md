# DAMAR IDENTITY MIGRATION — Aether → Damar, Colony/anak buah → Pandawa

**Status:** diterapkan di atas fondasi tersertifikasi Wave 4 Lane 3
(Actuation Fabric V1, commit `559bd1f`).
**Tidak termasuk:** Wave 4 Lane 4 (Verification + Compensation). Tidak ada
verifikasi efek, rollback, kompensasi, atau validasi postcondition yang
ditambahkan oleh migrasi ini.

---

## 1. Alasan & lingkup

Proyek ini semula dikembangkan dengan nama **Aether** dan berganti nama
menjadi **Damar** setelah Wave 4 Lane 3. Kolektif spesialisnya berganti
nama menjadi **Pandawa** dengan lima anggota bernama: Puntadewa,
Werkudara, Janaka, Nakula, Sadewa.

Migrasi ini **hanya** memindahkan identitas AKTIF. Ia bukan penggantian
string global: setiap kemunculan diklasifikasikan lebih dulu, dan
kategori historis / eksternal / semantik-tak-terkait sengaja
dipertahankan.

Hukum identitas sesudah migrasi:

- **Damar** = satu-satunya identitas asisten aktif yang kanonik.
- **Pandawa** = kolektif spesialis kanonik, milik Damar.
- **Aether** = nama sebelumnya; hidup sebagai catatan sejarah dan
  sebagai lapisan kompatibilitas yang DEPRECATED.

---

## 2. Kontinuitas Aether → Damar

Rename ini adalah **transisi identitas**, bukan entitas baru:

| Tempat | Bentuk kontinuitas |
|---|---|
| `src/consciousness/SelfModel.js` | `nama: "Damar"`, `namaSebelumnya: "Aether"`, `catatanIdentitas` menjelaskan transisi |
| `DamarSelf/identity.md` | baris eksplisit: "Dahulu aku bernama Aether… yang berganti adalah nama, bukan yang bernama" |
| `DamarSelf/journal.md` | entri lama **tidak ditulis ulang**; ditambahkan entri baru bertanggal yang mencatat pergantian nama |
| `src/services/damarSelfService.js` | `adoptLegacySelfDir()` mengadopsi isi `AetherSelf/` yang masih ada di disk pemilik |

Judul berkas jurnal diubah menjadi `# Jurnal Damar (dahulu Aether)` —
judul, bukan entri; seluruh entri lama tetap byte-exact.

---

## 3. Pandawa

```
                       Damar
            identitas & kognisi kanonik
                         │
                         ▼
                      Pandawa
                         │
   ┌────────────┬────────┼────────┬────────────┐
   ▼            ▼        ▼        ▼            ▼
Puntadewa   Werkudara  Janaka   Nakula      Sadewa
```

| Anggota | Domain |
|---|---|
| Puntadewa | Tata kelola, perencanaan & penilaian |
| Werkudara | Keamanan & pertahanan |
| Janaka | Riset & intelijen |
| Nakula | Rekayasa & operasi |
| Sadewa | Memori, analisis & kontinuitas |

Pemetaan dari peran lama (10 → 5):

| Lama | Baru | Alasan |
|---|---|---|
| `atlas` (otomatisasi/orkestrasi) | `puntadewa` | koordinasi & orkestrasi = tata kelola |
| `cipher` (keamanan) | `werkudara` | domain identik |
| `vanta` (riset/analisis) | `janaka` | domain identik |
| `forge` (software engineering) | `nakula` | rekayasa |
| `nexus` (sistem/infra) | `nakula` | operasi/DevOps |
| `sera` (vision) | `nakula` | integrasi perangkat |
| `echo` (suara) | `nakula` | integrasi perangkat |
| `lumen` (antarmuka/kanal) | `nakula` | integrasi kanal |
| `mira` (memori) | `sadewa` | memori |
| `pulse` (monitoring) | `sadewa` | analisis data & pengenalan pola |

Profil tool (`src/agent/agentTools.js`) adalah **gabungan** profil
pendahulunya, kecuali Puntadewa yang sengaja dibuat baca-dominan —
perencana perlu melihat keadaan, bukan mengubahnya.

### Batas kewenangan (tidak berubah oleh rename)

```
PLAN         != AUTHORITY
MEMORY       != AUTHORITY
MODEL CLAIM  != AUTHORITY
CHANNEL      != AUTHORITY
SECURITY     != BYPASS
ENGINEERING  != FREE EXEC
RESEARCH     != TRUTH
```

Mekanismenya tetap sama persis seperti sebelum rename:
`AgentHub.delegatedRoleOf(exec)` (worker mewarisi otoritas delegator,
identitas hilang → `user` least-privilege), `assertRestrictionsPreserved()`
(gagal-keras bila `capabilitySet` lenyap di transit), dan penyaringan
seleksi tool oleh `capabilitySet` yang sama.

---

## 4. Kebijakan pelestarian sejarah

Berkas berikut **sengaja tidak disentuh** dan tetap menyebut "Aether":

| Berkas / pola | Alasan |
|---|---|
| Riwayat Git (seluruh commit) | tidak ditulis ulang |
| `ACTION_LOG.md` | log kronologis; ditambahkan entri baru, isi lama utuh |
| `docs/journal/*.json` | jurnal bertanggal |
| `docs/adr/ADR-*.md` | Architecture Decision Record = catatan keputusan pada waktunya |
| `docs/audit-276.json`, `docs/aether-lab-audit.md`, `docs/architecture/initial-environment-audit.md` | snapshot audit |
| `graphify-out/**` (termasuk snapshot bertanggal) | artefak indeks yang dihasilkan mesin |
| `_pruned_plugins/**` | plugin yang sudah dipangkas (arsip) |
| `*.bak`, `*.bak-*`, `*.bak2`, `*.bak3` | salinan cadangan |
| `providers/**` | pohon vendor pihak ketiga |
| `forge-task.md` | brief tugas sekali pakai |
| `userPlugins/*/manifest.json` → `author: "aether-forge"`, `"origin": "aether"` | provenance: siapa yang membuat tool itu, dan kapan. Tool BARU kini dicatat `damar-forge`. |
| `// Dibuat oleh Aether ToolForge.` / `// Skill buatan Aether Skill Factory` pada plugin lama | header hasil generasi pada saat itu; generator kini menulis "Damar" |
| `userPlugins/patch-audio-console/*` (menerbitkan `aether:present`) | tool patch SEKALI-PAKAI yang sudah diterapkan; event kanonik di kode aktif kini `damar:present` |
| `patches/probe-3-multiline.txt` | artefak probe |
| berkas `-tree -r --name-only HEAD` | artefak nyasar dari perintah git yang salah bentuk |

---

## 5. Referensi yang bukan identitas ini (semantik berbeda)

Diklasifikasikan dan **tidak** diubah:

| Referensi | Klasifikasi |
|---|---|
| `AetherGenesis`, entitas `Viel` / `Nyx` / `NODEK-01`, `C:\AetherGenesis\…`, port 8642/8644/8650 | **sistem eksternal terpisah**, bukan identitas proyek ini |
| `apps/console/renderer/colonyChat.js`, `window.DamarColonyChat`, `userPlugins/*colony*`, `/api/colony/*` | "Colony" di sini = koloni entitas AetherGenesis di atas, **bukan** kolektif spesialis proyek ini |
| `aether-entities/lib/mind.js` | pustaka klien eksternal |
| `ToolForge`, `src/services/toolForge.js`, `docs/forge.md`, `forgeController`, `purpose: "forge"`, kolom DB `source = 'forge'` | **Forge = konsep produk/workspace pembuatan tool**, bukan identitas kolektif agen |
| `forged`, `forgery`, `unforgeable`, `REJECTED_FORGED_TOKEN`, `PID_SESSION_FORGED` | kosakata keamanan (pemalsuan), tak berkaitan |
| `memory_forget`, `forget` | kata kerja biasa |
| `pulse` pada animasi CSS, `cipher` pada `src/runtime/vault/cipher.js`, `echo` pada tool MCP uji | kata umum / kriptografi, bukan nama agen |
| `C:\Workspace\Aether`, `/mnt/c/Workspace/Aether` | path checkout nyata di mesin pemilik |
| `github.com/jrxid09-design/Aether` | URL repositori (kontrak eksternal) |
| `docs/aether-lab-audit.md` (nama berkas) | dirujuk sebagai dokumen historis |
| `providers/external/Gemini-API/aether_bridge.py` | berkas di dalam pohon vendor |
| `kali-aether` (`userPlugins/kali-exec`) | nama kontainer Docker yang SUDAH ADA di mesin pemilik, dibuat sebelum rename; `src/kali/bridge.js` sendiri memakai deteksi distro WSL + `DAMAR_KALI_DISTRO` |
| `AETHER_CONSOLE_APP_JS`, `AETHER_MEDIATOOLS_JS`, `AETHER_PORT`, `AETHER_TOKEN` di dalam `userPlugins/**` | dilayani lapisan alias env (§6); tidak perlu diubah |

Catatan: "Colony" **dalam pengertian arsitektur proyek ini** (port
`contextRefs` di `src/ai/context/*`, `docs/CONTEXT-INTELLIGENCE.md`,
beberapa dokumen arsitektur) MEMANG dimigrasikan menjadi "Pandawa".
Yang tidak dimigrasikan hanyalah Colony milik AetherGenesis.

---

## 6. Kompatibilitas yang sengaja dipertahankan

Semuanya berarah kanonik ke Damar, tidak satu pun menciptakan identitas
atau penyimpanan kedua, dan tidak satu pun melemahkan Authority.

| Permukaan | Lama (DEPRECATED) | Kanonik | Mekanisme |
|---|---|---|---|
| Env | `AETHER_*`, `AETHERSELF_DIR` | `DAMAR_*`, `DAMARSELF_DIR` | `src/config/envCompat.js` — alias dua arah, tidak pernah menimpa, tidak pernah MENCIPTAKAN kunci yang absen (fail-closed tetap) |
| Header HTTP | `x-aether-channel` | `x-damar-channel` | dibaca sebagai cadangan di `aiController.channelOf()`; keduanya di allowlist CORS. Kanal tetap ≠ otoritas |
| Bridge Electron | `window.aether` | `window.damar` | objek yang **sama** di-expose dua kali (`preload.js`) |
| Manifest ekstensi | `aether-extension.json` | `damar-extension.json` | `discovery.js` mencoba ejaan lama hanya bila kanonik tidak ada dan nama tidak di-override |
| Field manifest | `runtime.aether` | `runtime.damar` | dinormalkan ke kunci kanonik di `manifest.js`; kanonik menang bila keduanya ditulis |
| Override runtime | `overrides.aether` | `overrides.damar` | fallback kunci lama di `runtimeService.cfg()` |
| localStorage companion | `aether_companion_*` | `damar_companion_*` | diadopsi sekali saat pembacaan pertama (`deviceWeb.js`) |
| Id agent | `vanta`/`cipher`/`atlas`/`forge`/`nexus`/`sera`/`echo`/`lumen`/`mira`/`pulse`/`aether` | lima Pandawa + `damar` | `AgentHub.LEGACY_AGENT_ALIAS`; alias TIDAK muncul di `agents()` |
| Pemicu WhatsApp | kata "aether" | kata "damar" | keduanya memicu identitas yang **sama** |
| Penanda konten | `[[AETHER:…]]` | `[[DAMAR:…]]` | netralisasi diperluas ke KEDUA ejaan — cakupan pertahanan hanya melebar |
| `.gitignore` | `AETHER_STATE.json`, `AETHER_SELF.md`, `AetherSelf/` | padanan `DAMAR_*` | kedua ejaan tetap diabaikan |
| Kontainer TTS | `aether_kokoro` | `damar_kokoro` | `userPlugins/kill-other-tts` mencocokkan KEDUA ejaan agar kontainer pra-rename tetap bisa dihentikan |

Lapisan kompatibilitas ini bersifat sementara dan harus dicabut pada
rilis mayor berikutnya.

---

## 7. Migrasi persistensi

| Data | Lama → Baru | Sifat |
|---|---|---|
| SQLite utama | `data/aether.db` → `data/damar.db` (+ sidecar `-wal`, `-shm`) | `fs.renameSync` sebelum koneksi dibuka, **hanya** bila berkas kanonik belum ada; idempoten; tidak pernah menimpa; tidak pernah dua penyimpanan aktif |
| Dokumen diri | `AetherSelf/` → `DamarSelf/` | salin-bila-absen rekursif, tidak pernah menimpa; lokasi lama ditandai `MIGRATED.md` |
| Pairing companion | `aether_companion_{token,name,settings}` | diadopsi sekali per-device di browser |
| Override runtime | `configs/runtimes.json → overrides.aether` | dibaca sebagai cadangan (berkas tidak ditulis ulang) |

`data/memory.db` dan `data/channels.db` tidak bernama-merek dan tidak
berubah. Nilai kolom historis (`writer`, `source`, `decision_maker`)
pada baris lama tetap `'aether'` — itu catatan siapa yang menulis saat
itu; hanya nilai default untuk baris BARU yang menjadi `'damar'`.

---

## 8. Yang TIDAK berubah (fondasi tersertifikasi Lane 1–3)

Migrasi ini tidak menyentuh semantik keamanan mana pun:

- Capability Registry & Graph — hanya deskripsi `Symbol()` yang berubah
  ejaan. Deskripsi Symbol **bukan** identitas (`Symbol(x) !== Symbol(x)`);
  tes yang memalsukan Symbol berdeskripsi sama ikut diganti ejaan dalam
  langkah yang sama agar tetap membuktikan hal yang sama.
- Action Intent + Authority Gate, kepemilikan bootstrap kanonik,
  autentikasi fail-closed, provenance sesi, revalidasi otoritas segar.
- Actuation Fabric: `src/action/actuation/index.js` tetap hanya
  mengekspor kosakata inert; konstruktor privileged tetap privat di
  closure `src/action/bootstrap.js`.
- Disiplin inkarnasi kapabilitas & aktuator, penanganan duplikat,
  semantik timeout/pembatalan.
- Kill switch: `READ_ONLY_ALLOWLIST` diganti ejaan secara atomik
  bersama id plugin `aetherSkills` → `damarSkills`, sehingga tidak ada
  arah desinkronisasi yang membuka izin.
- Klasifikasi risiko (`riskCatalog`) diganti ejaan dalam satu langkah
  atomik yang sama; `tests/safety/riskPolicy.test.js` tetap menjadi
  penjaga bahwa tool rumah/pesan keluar tetap terklasifikasi berisiko.

---

## 9. Perubahan identifier teknis

| Kategori | Perubahan |
|---|---|
| Direktori | `AetherSelf/` → `DamarSelf/`, `src/plugins/aetherSkills/` → `damarSkills/`, `tests/aetherSelf/` → `tests/damarSelf/`, `userPlugins/aether-*` → `damar-*` |
| Modul | `aetherSelfService.js` → `damarSelfService.js`, `aetherAgent.js` → `damarAgent.js`, `AetherError.js` → `DamarError.js` |
| Konsol | `aether-voice.js`, `aetherOverlay.js`, `aetherState.js`, `views/aether.js`, `styles/aether.{chrome,tokens}.css`, `AETHER_CHARACTER_RULES.md`, `aether-geometry.json` → padanan `damar*` |
| Simbol | `createAetherSelfService` → `createDamarSelfService`, `AetherError` → `DamarError`, `runAether` → `runDamar`, `AetherAgent` → `DamarAgent` |
| Deskripsi Symbol | `Symbol("aether.*")` → `Symbol("damar.*")` (netral terhadap perilaku) |
| Kelas CSS | `.aether-*` → `.damar-*` |
| Namespace plugin | `aetherSkills.*` / `aetherSkills__*` → `damarSkills.*` / `damarSkills__*` |
| Kontainer voice | `aether-voice`, `aether_{kokoro,piper,whisper}` → `damar-*` (lihat catatan operator di §11) |
| Nama paket | `aether` → `damar`, `aether-console` → `damar-console` |
| Fixture uji | `aether-core` → `damar-core` |

---

## 10. Uji penerimaan

`tests/identity/damarIdentity.test.js` (16 uji) membuktikan poin 1–13
dari daftar penerimaan: identitas kanonik, perkenalan diri, konsistensi
kanal, model ≠ identitas, Aether sebagai konteks lama saja, kolektif
Pandawa dengan lima nama persis, domain tiap anggota, tidak adanya
otoritas independen (termasuk Sadewa/Werkudara/Nakula secara spesifik),
serta migrasi persistensi yang aman-restart dan idempoten.

---

## 11. Catatan operator

Stack suara memakai nama proyek/kontainer Docker baru
(`deploy/voice/docker-compose.yml`). Kontainer lama tidak ikut berganti
nama sendiri; hapus sekali sebelum menjalankan versi baru:

```
docker compose -p aether-voice -f deploy/voice/docker-compose.yml down
docker compose -f deploy/voice/docker-compose.yml up -d
```

Volume berupa bind-mount ke path dari `configs/nas.json`, jadi model
Whisper/Piper yang sudah terunduh tidak hilang.
