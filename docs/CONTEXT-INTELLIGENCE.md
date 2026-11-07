# CONTEXT INTELLIGENCE — Pipeline Context Damar

Dokumen ini menjelaskan lapisan **Context Intelligence**: sistem yang
menjawab *"informasi apa yang benar-benar perlu diketahui model pada
giliran ini?"* — melengkapi Tool Intelligence (*"tool mana yang perlu
diketahui model?"*) tanpa menggabungkannya menjadi satu god-class.

---

## OLD — sebelum pipeline

```
session (≤40 pesan, ukuran tak terbatas)
        ↓ semua verbatim
system prompt 2.570 token (selalu) + doktrin + kanal
        ↓
memory.buildContext → ditempel mentah ke pesan user terakhir
mind.stateOfMind    → ditempel mentah
        ↓
tool results: dibungkus boundary, TIDAK pernah dipotong/didedupe
```

Cacat yang ditemukan audit: sesi & pesan tanpa batas ukuran; API
surface (Console/v1openai) menerima array arbitrer; observasi tool
raksasa mewarisi seluruh iterasi turn dan hilang begitu turn selesai;
duplikasi history↔memory; nonce acak pada contentBoundary membatalkan
prefix cache setiap giliran; tidak ada anggaran/relevansi/dedupe.

## NEW — pipeline

```
messages dari kanal (apa pun sumbernya)
        ↓ SANITIZE          ≤40 pesan, ≤6.000 char/pesan  ← pagar anti-explosion
        ↓ SPLIT             recent window (8 pesan) vs older
        ↓ SOURCES           adapter existing: persona/device, doctrine,
        │                   channelPrompt, MemoryService, consciousness,
        │                   contextRefs (port Pandawa)
        ↓ RELEVANCE         skoring deterministik; ambang untuk history,
        │                   memory/refs/mind dikecualikan (sudah lolos
        │                   alasan pemilihan di sumbernya)
        ↓ DEDUPE            fingerprint ternormalisasi lintas sumber
        ↓ BUDGET            model-aware: window − output − tool − margin
        │                   → alokasi per kategori dengan langit-langit
        ↓ COMPRESS          structural: seleksi baris → head+tail (tanpa LLM)
        ↓ ASSEMBLE          [stabil: device→persona→directive→channel]
        │                   [recent utuh] + blok dinamis pada user terakhir
        ↓ Tool Intelligence (tidak berubah)
      Provider
```

Lokasi: `src/ai/context/`. Titik masuk tunggal:
`aiRuntimeService.assemble()` — dipakai `chat()` dan `stream()`.
Escape hatch: `DAMAR_CONTEXT_PIPELINE=legacy` menjalankan rantai lama
(`withSystemPrompt → withMemory → withMind`) utuh untuk rollback.

### Modul

| Modul | Tugas |
|---|---|
| `ContextItem.js` | Satuan context ternormalisasi (kind/priority/stable/mandatory/compressible/provenance) |
| `sources.js` | Adapter ke sistem existing — TIDAK ada memori/session store kedua |
| `Relevance.js` | Skor leksikal + referensi eksplisit ("kemarin", "yang tadi") + recency bucket |
| `Dedupe.js` | Fingerprint konten (label peran dibuang); prioritas tertinggi menang; provenance dicatat |
| `ContextBudget.js` | dynamicBudget = window − 1024(out) − 512(margin) − stableTokens − toolAllowance; caps per kategori |
| `Compressor.js` | Seleksi baris tak relevan → head+tail dengan penanda jumlah yang dipangkas |
| `Assembler.js` | Urutan kontrak: stabil di depan, dinamis (recap→memori→batin) di belakang |
| `refs.js` | Registry resolver `kind:id` — port bersih untuk Pandawa/Lab tanpa membangunnya |
| `Pipeline.js` | Orkestrasi + sanitasi + telemetri `context:selection` |

### Keputusan desain penting

1. **Correctness > reduksi.** Required-context wajib selamat. Item
   memory/refs/mind tidak pernah dibuang ambang relevansi — alasan
   pemilihannya sudah ada di sumber (retrieval). Yang dibatasi adalah
   ANGGARAN dan KOMPRESI.
2. **Recent vs relevant.** 8 pesan terakhir utuh (kontinuitas); pesan
   lebih lama menjadi kandidat — hanya yang menyentuh topik aktif atau
   ditandai referensi eksplisit yang kembali sebagai blok RIWAYAT
   RELEVAN.
3. **Prefix cache.** Stabil di depan; semua yang berubah ditempel ke
   pesan pengguna terakhir (pola terukur lama: 12,2 dtk → 1,4 dtk).
   `contentBoundary.wrap` kini memakai hash konten (bukan nonce acak)
   sehingga konten sama → byte prompt sama.
4. **Observasi tool berbatas** (di RuntimeExecutor): >4.000 char →
   head+tail + penanda; RAW diarsipkan ke `logs/tool-observations/`
   untuk audit; observasi identik dalam satu giliran didedupe.
5. **Degradasi anggun.** Kegagalan adapter/sumber hanya mengurangi
   kandidat. Kegagalan pipeline sendiri tetap menyerahkan pesan yang
   SUDAH disanitasi — pagar anti-explosion bukan fitur opsional.

### Telemetri (`context:selection`)

```
candidates, selected, tokensBefore/After, reductionPct,
breakdown{system, recentHistory, dynamic, byKind},
dedupedRemoved, inputMessagesDropped, selectionMs, channel
```

Tanpa nilai rahasia, tanpa raw memori sensitif.

### Env var

| Variabel | Default | Arti |
|---|---|---|
| `DAMAR_CONTEXT_PIPELINE` | pipeline | `legacy` = jalur lama |
| `DAMAR_CONTEXT_MAX_MESSAGES` | 40 | Batas keras pesan masuk |
| `DAMAR_CONTEXT_MAX_MSG_CHARS` | 6000 | Batas char per pesan |
| `DAMAR_CONTEXT_RECENT` | 8 | Ukuran jendela recent |
| `DAMAR_OBSERVATION_MAX_CHARS` | 4000 | Batas satu observasi tool |
| `DAMAR_MODEL_CONTEXT_TOKENS` | 32768 | Window model aktif |

### Benchmark

```bash
node scripts/benchmark-context-intelligence.js [--verbose] [--json]
```

62 kasus × 20 kategori (greeting, factual, recent/old continuation,
project ref, memory required/not-required, conflict, long conversation,
observasi besar/berulang, skill, worker mission, multilingual, model
kecil/besar, noisy session, stale memory, degraded source, duplication).

Hasil terukur:

| Metrik | OLD | NEW |
|---|---|---|
| **required-context recall** | 1.000 | **1.000** (0 miss) |
| noise leak (forbidden) | 0 | 0 |
| total est. input tokens | 45692 | **7005 (−85%)** |
| observasi tak berbatas | 0 | 0 |
| deterministik (repeat) | 62/62 | 62/62 |

Urutan penilaian sesuai mandat: correctness → recall → reduksi noise →
reduksi token → latency.

### Test

```bash
node --test --test-concurrency=1 tests/safety/contextIntelligence.test.js
```

19 test: greeting minimal, old-topic retrieval, recent-tak-relevan
kalah, mandatory retained, budget 8K vs besar, dedupe (+pendek aman),
determinisme, urutan kontrak blok, kompaksi head+tail, MAX_MESSAGES/
MAX_CHARS, degradasi refs rusak, paritas kanal, urutan system, port
refs (tanpa resolver → catatan; dengan resolver → item berbatas).

### Kolony readiness

Worker AgentHub sudah lewat pipeline yang sama; `agentHub.run(agentId,
task, { contextRefs })` dan `aiRuntime.chat({ contextRefs })`
menerima referensi. Pandawa kelak cukup mendaftarkan resolver
(`refs.registerResolver("project", ...)`) — director mengirim
`contextRefs`, bukan salinan context penuh.
