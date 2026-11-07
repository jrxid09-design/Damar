# TOOL INTELLIGENCE — Pipeline Seleksi & Eksekusi Tool Damar

Dokumen ini menjelaskan evolusi arsitektur tool-calling Damar: dari
"daftar tool yang dikirim mentah ke model" menjadi pipeline seleksi
yang deterministik, hemat konteks, aman, dan model-agnostik.

---

## OLD — sebelum evolusi

```
160+ tool terdaftar
        ↓
semua schema dikirim ke LLM (atau profil statis ToolSelector)
        ↓
model memanggil → langsung dieksekusi → {error: "pesan bebas"}
```

Masalah nyata yang pernah terjadi: superadmin Telegram mengirim ±160
schema tool ke Qwen 7B (context 8192) → prompt jebol, model gagal.
Profil statis ToolSelector menutup insiden itu tetapi meninggalkan
utang: daftar per-domain di-hardcode, admin channel masih menerima
daftar penuh hasil filter regex, dan tidak ada angka untuk mengukur
kualitas seleksi.

## NEW — pipeline saat ini

```
registry (+metadata kapabilitas)
        ↓
CapabilityIndex      normalisasi metadata tiap tool
        ↓
CapabilityRetriever  pencocokan leksikal deterministik + kosakata ID→EN
        ↓
PermissionFilter     roleService.allows(role) + metadata channels/roles
        ↓
ToolRanker           skor stabil: retrieval + keandalan + risiko/kanal
        ↓
ToolBudget           context-aware: window model → maxTools + anggaran token skema
        ↓
SchemaMinimizer      tampilan minimum: nama + deskripsi terpangkas + parameter inti
        ↓
LLM                  hanya melihat Top-K yang relevan (+ tool_search)
        ↓
ArgumentValidator    validasi + normalisasi argumen SEBELUM eksekusi
        ↓
ToolGuard            killSwitch → riskPolicy → loopGuard → pathPolicy (TIDAK berubah)
        ↓
Execution            timeout per-tool, klasifikasi error machine-readable
        ↓
Observation          ToolStats (rolling) → kandidat replan/retry berbatas (TurnController)
```

Lokasi kode: `src/ai/tools/` (pipeline) dan `src/ai/executors/RuntimeExecutor.js`
(eksekusi). Jalur masuk tunggal: `AIRuntime.resolveTools()`.

### Modul

| Modul | Tugas |
|---|---|
| `CapabilityIndex.js` | Metadata kapabilitas per tool; penurunan otomatis dari nama (`mcp__`, `plugin__`) + riskCatalog |
| `Vocabulary.js` | Jembatan bahasa Indonesia → istilah Inggris pada nama/deskripsi tool (tingkat domain, bukan per tool) |
| `Retriever.js` | Kandidat berskor > 0; bobot: nama utuh > tail > keyword > potongan nama > deskripsi; sinyal kosakata setengah bobot |
| `Ranker.js` | Pagar kelayakan (peran/kanal) + boost keandalan/risiko; seri diputus abjad → deterministik |
| `Budget.js` | Profil per ukuran konteks (≤10K/≤40K/≤160K/>); anggaran skema = 35% sisa konteks; backbone di-reserve |
| `SchemaMinimizer.js` | Tampilan model-facing; skema eksternal dipangkas ke semantik minimum |
| `ArgumentValidator.js` | Validasi + koersi ringan; kode: VALIDATION_ERROR, PERMISSION_DENIED, POLICY_DENIED, TOOL_NOT_FOUND, EXECUTION_ERROR, TIMEOUT, CANCELLED |
| `TurnController.js` | Batas giliran: maxToolCallsPerTurn, maxRetriesPerTool, wall clock, AbortSignal |
| `ToolStats.js` | Agregat bergulir sukses/gagal/latensi per tool; persisten (data/tool-stats.json); dipakai ranker konservatif (≥5 sampel) |
| `toolSearch.js` | Tool `tool_search`: satu pintu discovery; hasilnya memicu disclosure schema pada putaran berikutnya |
| `Pipeline.js` | Orkestrasi + diagnostik (`tool:selection`) |

### Jaminan perilaku

- **Sapaan → nol tool.** "halo" tidak melampirkan apa pun; system prompt
  eksplisit melarang model mengarang nama tool saat daftarnya kosong.
- **Deterministik.** Pesan + keadaan registry yang sama → seleksi identik.
- **Backbone terjamin** saat ada seleksi: memory_recall/memory_remember/
  currentTime/readFile/listDirectory — yang berhasil bersaing dibiarkan
  naik peringkat; sisanya dicadangkan di belakang.
- **tool_search selalu terlihat** ketika ada tool terlampir; model tak
  pernah tersangkut tanpa cara menemukan kemampuan.
- **Satu jalur untuk semua kanal.** Console, Telegram, WhatsApp, Voice,
  companion, worker AgentHub — semua lewat Pipeline; kanal hanya
  menyumbang `channel` + `role`. `DAMAR_TOOL_PIPELINE=legacy` adalah
  katup darurat ke profil statis lama.
- **MCP first-class tapi tak dipercaya penuh**: masuk discovery lewat
  metadata `source:"mcp"`, tetap dijaga toolGuard penuh, penalti kecil
  saat ambigu.

### Anggaran konteks (context-aware, tanpa hardcode model)

| Window | maxTools | descChars | paramDescChars |
|---|---|---|---|
| ≤10K | 8 | 90 | 60 |
| ≤40K | 16 | 160 | 80 |
| ≤160K | 24 | 220 | 110 |
| >160K | 32 | 240 | 120 |

Ukuran window dibaca dari `DAMAR_MODEL_CONTEXT_TOKENS` (atau default
konservatif 32768). Tidak ada nama provider/model yang di-hardcode.

### Observability

Event telemetri `tool:selection` per giliran:
`registeredTools, candidateTools, selectedTools, toolScores,
selectionReasons, schemaTokensBefore/After, budget, channel, role,
selectionLatencyMs`. Semua metadata teknis — tanpa reasoning model.
Argumen sensitif tidak pernah ikut event.

### Benchmark

Dataset 65 intent berkategori + registry sintetis 114 tool:

```bash
node scripts/benchmark-tool-intelligence.js [--verbose] [--json]
```

Hasil terukur (OLD selectTools vs NEW Pipeline):

| Metrik | OLD | NEW |
|---|---|---|
| recall | 0.75 | **1.00** |
| top-3 hit | 4/59 | **48/59** |
| precision | 0.043 | **0.103** |
| rata-rata tool/pesan | 20.32 | **11.37** |
| total token skema | 40968 | **25075** (−39%) |
| false positive (greeting) | 0 | 0 |
| determinisme | stabil | stabil |

Angka di atas diukur pada dataset repo; jalankan skrip untuk mereproduksi.

### Test

```bash
node --test --test-concurrency=1 tests/safety/toolIntelligence.test.js \
                              tests/safety/toolExecution.test.js
```

Meliputi: greeting nol tool, determinisme, paritas kanal, filter peran,
kanal metadata, MCP dinamis tanpa hardcode, minimisasi schema, profil
anggaran, validasi argumen (ditolak tanpa dieksekusi), normalisasi
koersi, error terstruktur, kill switch → POLICY_DENIED, TIMEOUT,
AbortSignal, MAX_TOOL_CALLS/MAX_SAME_ERROR, isolasi kegagalan MCP,
dan metrik ToolStats.

### Env var

| Variabel | Default | Arti |
|---|---|---|
| `DAMAR_MODEL_CONTEXT_TOKENS` | 32768 | Ukuran window model aktif |
| `DAMAR_TOOL_BUDGET` | (dari profil) | Override maxTools |
| `DAMAR_TOOL_PIPELINE` | smart | `legacy` = profil statis lama |
| `DAMAR_TOOL_TIMEOUT_MS` | 120000 | Timeout satu panggilan tool |
| `DAMAR_MAX_TOOL_CALLS_PER_TURN` | 12 | Batas panggilan per giliran |
| `DAMAR_MAX_RETRIES_PER_TOOL` | 2 | Batas error sama per tool per giliran |
| `DAMAR_TURN_WALLCLOCK_MS` | 300000 | Langit-langit waktu satu giliran |

---

## SECURITY HARDENING V2 (pasca audit merah)

Audit independen read-only diverifikasi ulang (VERIFY→REPRODUCE→CLASSIFY):
C1–C6, G1–G8, H5–H12 **CONFIRMED/PARTIAL**; H2 DESIGN_TRADEOFF (diukur).
Semua Critical/High kini ditutup dengan bukti test.

### Invarian keamanan (ditegakkan kode + test)

- **A** disclosure ≠ execution — `Authorization.assertExecution()` di
  `ToolExecutor` TEPAT sebelum eksekusi
- **B** komponen keamanan hilang → DENY (fail-closed)
- **C** model boleh meminta, tidak pernah memberi otoritas
- **D** metadata MCP = input tak terpercaya; provenance ditentukan internal
- **E/F** discovery, tool_search, deferred disclosure = universe berizin sama
- **G** identitas eksekusi wajib; tanpa identitas → peran 'user'
- **H** flag bypass (`bridged`) wajib terbukti: registry-inti memegang id
  **DAN** `guardedInternally=true`
- **I** nama/alias eksternal tak mewarisi sinyal identitas internal
- **J** satu policy universe untuk semua permukaan

### Perubahan utama

| Area | Sebelum | Sesudah |
|---|---|---|
| Otorisasi eksekusi | tidak ada | `Authorization` (satu engine, mengevolusi roleService+riskCatalog) |
| riskPolicy | no-op klasifikasi | klasifikasi tetap; keputusan izin = `Authorization` (binary destructive × authority × channel) |
| v1openai | token kosong = open | fail-closed 503; `DAMAR_UNSAFE_DEV_OPEN_API=1` eksplisit; role API default `user` |
| roleOf kosong | superadmin implisit | `user` (pemilik naik via /masuk atau roles.json; Console/CLI eksplisit `superadmin`) |
| tool_search | registry penuh | universe berizin per identitas |
| request.tools | bypass penuh | kandidat → diiriskkan |
| legacy hatch | tanpa gate | gate sama, algoritma beda |
| loopGuard | global, reset-setelah-pelanggaran | session-scoped, sticky cooldown 30s; TurnController deteksi siklus A-B-A-B & alternating-error |
| ToolStats | reliability lifetime | rolling N-outcome; substitusi dicatat requested≠executed |
| SchemaMinimizer | enum dipangkas, required bisa menggantung | constraint penuh dipertahankan; `$ref/oneOf/anyOf/allOf` → fallback full bertanda; depth/node caps |
| ArgumentValidator | top-level saja | rekursif berbatas: nested/enum/const/pattern/bounds/additionalProperties/union; tanpa echo nilai |
| MCP | deskripsi mentah, readOnly-by-default | deskripsi ≤300 char + dinetralkan; external = `sideEffects:true`, `readOnly:false` |

### Benchmark V2 (REAL registry — bukan fixture)

`DAMAR_BENCH_STUB_NATIVE=1 node scripts/benchmark-tool-intelligence-v2.js`

- Registry asli runtime: **281 tool** (164 native + 117 plugin + MCP dinamis)
- 74 seleksi × kasus adversarial (MCP mirror/stuffing/deep-schema,
  permission matrix, negative set, typo, multilingual, short tokens)
- **required recall 53/53 = 1.000** · top-3 49/53 · top-5 50/53
- **negative violations 0 · unauthorized disclosure 0 · unauthorized execution 0**
- schema est tokens: 175.603 terpilih vs 1.954.439 full-catalog (**−91%**)
- deterministik+parity 73/73

Angka V1 (fixture 114 tool) dipertahankan sebagai regresi historis —
BUKAN klaim produksi.

### Cache / prompt-eval (diukur, Phase 14)

`node scripts/benchmark-cache-stability.js` (registry nyata, 10 turn topik
bergeser; token = estimasi chars/4):

| Mode | prefix-all | prefix(non-empty) | est re-eval |
|---|---|---|---|
| LEGACY | 68.2% | 76.7% | 3.112 |
| NEW murni-dinamis (terukur buruk) | 3.1% | 34.4% | 12.379 |
| **NEW hybrid (final)** | **49.5%** | **55.7%** | **8.010** |

Hybrid = segmen stabil kanonik (backbone+meta, tetap lewat gerbang)
mendahului segmen dinamis. TTFT live: N/A di host ini — set
`DAMAR_TTFT_URL` untuk pengukuran nyata; tidak ada klaim TTFT tanpa data.


---

## HARDENING ROUND-2 (pasca audit merah kedua — status saat ini)

Semua temuan C1–C6, H1–H10 Round-1 + Round-2 diverifikasi dengan probe
eksekusi dan ditutup. Invarian inti yang KINI diuji:

- Wrapper ≠ otoritas: `tool_exec`/ToolBus meneruskan identitas pemanggil;
  tanpa identitas = user (bukan system). Test: admin via wrapper DENY.
- Semua permukaan jaringan fail-closed: token kosong → 503; dev-open
  eksplisit `DAMAR_UNSAFE_DEV_OPEN_API=1`; identitas berprovenance
  (`req.authIdentity.source`).
- Stream/non-stream parity eksekusi teruji.
- Provenance kanonik tunggal: `CapabilityIndex.provenanceOf()`
  (origin: native|plugin|mcp; trustClass: internal|installed|external-untrusted).
- /mcp konvergen ke choke point yang sama.
- Stable-segment = reserved dalam anggaran (maxTools=8 → disclosed ≤8);
  telemetry count == serialized count (`disclosedToolCount`).
- Window invariant serialized-final di TOOL & CONTEXT pipeline
  (`windowHardCap`, `overflowTrimmed`); window aktif dari konfigurasi
  llamacpp (bukan substitusi default).
- loopGuard scoped+sticky tanpa wildcard-reset runtime.
- Observasi dedupe memuat outcome/errorCode.

### Benchmark V2.1 (REAL registry 281 tool)

recall **53/53 = 1.000** · top-3 49/53 · negative 0 · unauthorized 0/0 ·
schema est 90.211 vs full-catalog 1.954.439 (**−95%**) · det+parity 73/73

### Cache (estimasi chars/4; legacy baseline eksplisit)

FULL-CATALOG 1.954.439 est · LEGACY prefix 68.2%/re-eval 3.112 ·
NEW hybrid prefix 42.5%/re-eval 4.829 · TTFT live NOT VERIFIED
(`DAMAR_TTFT_URL` tersedia untuk pengukuran).

### Suite (pelabelan jujur)

SECURITY/RELEVANT 147/147 · FULL 424 tests (400 pass; 24 = env/stale/
flaky terdokumentasi, lihat ACTION_LOG) · full suite ~50 dtk, force-exit
tidak lagi diperlukan sejak wrapper streaming diperbaiki.
