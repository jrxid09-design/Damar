# Evolusi Damar — Adopsi Pola OpenClaw

Dokumen ini mencatat hasil bedah [OpenClaw](https://github.com/openclaw/openclaw)
dan pola apa saja yang sudah diadopsi ke Damar sebagai **evolusi arsitektural**.
Ditulis untuk jadi peta "dari mana → ke mana", bukan sekadar changelog.

---

## 1. Bedah OpenClaw (ringkasan)

OpenClaw adalah *personal AI assistant* TypeScript (pnpm monorepo) yang berjalan
di perangkat operator dan bertemu pengguna lewat kanal yang sudah dipakai
sehari-hari. Inti arsitekturnya:

```
Operator/Node (macOS/iOS/Android/CLI/Control UI)
        │  WebSocket (ws://127.0.0.1:18789, protokol ber-versi)
        ▼
GATEWAY (daemon, 1 per host)
  ├─ Control plane  : RPC scope-gated + event broadcast (per-client seq)
  ├─ Channel layer  : ingress queue SQLite → debounce → routing → agent turn
  │                   (Telegram/WhatsApp/Slack/Discord/… = plugin transport-only)
  ├─ Agent runtime  : lane per-session + tool-calling loop + compaction
  ├─ Tools/Skills   : exec/read/write + SKILL.md + slash commands
  ├─ Plugin registry: manifest.json (dibaca TANPA eksekusi) → register(api)
  └─ Persistence    : SQLite-first ("no hidden state")
```

Pola kunci yang membuatnya tangguh:

| # | Pola | Inti |
|---|---|---|
| 1 | **Gateway tunggal** | semua state/policy terpusat; klien hanya view |
| 2 | **ChannelPlugin transport-only** | kanal = adapter tipis; core berbagi satu pipeline |
| 3 | **Ingress queue durable** | pesan masuk di-enqueue SQLite; tombstone anti-duplikat |
| 4 | **Pairing** | DM/node approval eksplisit (kode 8 char), bukan sekadar allowlist |
| 5 | **SessionKey grammar** | `agent:<id>:<channel>:group:<id>` → sesi lintas kanal |
| 6 | **SQLite-first** | session/transcript/state persist, bukan Map in-memory |
| 7 | **Event seq + scope-gated broadcast** | klien telat konek bisa *catch-up* tanpa replay penuh |
| 8 | **Sandboxing tool** | exec/read/write diisolasi (docker/podman), host tak disandbox |
| 9 | **Compaction** | ringkasan iterative; histori penuh tetap di disk |
| 10 | **Model fallback berlapis** | rotasi auth-profile → fallbacks; override user = strict |

---

## 2. Kelemahan Damar yang ditutup (peta dampak)

Sebelum evolusi, bedah menemukan 18 kelemahan arsitektural. Evolusi ini menutup
**6 di antaranya**, dipilih karena beririsan langsung dengan pola OpenClaw dan
aman diterapkan tanpa merombak core (prinsip *strangler-fig* di CLAUDE.md):

| Kelemahan lama | Pola OpenClaw | Solusi |
|---|---|---|
| Sesi percakapan `Map` in-memory, hilang saat restart (E.4) | SQLite-first (#6) | `src/channels/SessionStore` — sesi persist di `data/channels.db` |
| Tanpa abstraksi kanal; WhatsApp & Telegram copy-paste `converse()` (E.3, E.10) | ChannelPlugin (#2) | `src/channels/ChannelManager` — registry kanal berbagi pipeline |
| `currentChatId` global → media salah tujuan (E.8) | konteks permintaan | AsyncLocalStorage di `ChannelManager.runWithContext` |
| Telemetry = bus ad-hoc tanpa replay event (E.5) | Event seq (#7) | `telemetryService.events({since})` + SSE `Last-Event-ID` |
| Auth token non-constant-time + `/mcp` terbuka (E.6) | security posture | `core/auth/tokenCompare` + guard `/mcp` |

---

## 3. Yang berubah (peta file)

### Baru
- `src/channels/sessionStore.js` — `SessionStore` (SQLite, WAL, grammar kunci sesi
  `channel:<kanal>:<kind>:<peer>`, jendela 20 giliran, list/clear, persist lintas reopen).
- `src/channels/channelManager.js` — `ChannelManager` (registry kanal, `runWithContext`
  AsyncLocalStorage, `activeChat()` konteks-dulu-fallback-belakangan, helper sesi).
- `src/channels/index.js` — titik masuk subsistem.
- `src/core/auth/tokenCompare.js` — `tokensEqual` (SHA-256 + timingSafeEqual),
  `extractToken`, `tokenGuard`.
- `src/controllers/channelController.js` — REST `list` / `sessions` / `clearSession`.
- `tests/channels/{sessionStore,channelManager}.test.js`, `tests/auth/tokenCompare.test.js`,
  `tests/telemetry/replay.test.js` — 23 test baru.

### Diubah
- `src/services/telemetryService.js` — `eventBuffer` + `events({since})`.
- `src/controllers/telemetryController.js` — SSE replay via `Last-Event-ID` / `?since=`.
- `src/services/whatsappService.js` — sesi → SessionStore; konteks permintaan di `handle`.
- `src/services/telegramService.js` — idem; tambah `/reset` (paritas WhatsApp).
- `src/services/mediaShareTools.js` — `activeChannel()` konteks-dulu.
- `src/services/whatsappTools.js` — `ensureChat()` konteks-dulu.
- `src/middleware/auth.js` — delegasi ke `tokenGuard` (constant-time).
- `src/mcp/index.js` — `/mcp` & `/mcp/health` dijaga token.
- `scripts/mcp-stdio.js` — meneruskan `DAMAR_TOKEN` sebagai Bearer.
- `src/server.js` — registrasi kanal + `start/stop` subsistem kanal.
- `src/routes/api/v1/console.js` — rute `/channels`, `/channels/sessions`.
- `tests/helpers/testEnv.js` — isolasi `DAMAR_CHANNEL_DB` (pola memori/audit).

---

## 4. Peta adopsi selanjutnya (belum dikerjakan)

Pola OpenClaw lain yang sudah terpetakan tapi **sengaja belum** diadopsi,
karena butuh perubahan lebih dalam atau sudah tercakup subsistem Damar:

- **Ingress queue durable + tombstone** (#3) — WhatsApp/Telegram saat ini
  langsung proses di event handler; redelivery platform belum di-dedupe.
- **Pairing (#4)** — Damar masih allowlist statis; kode 8-char + approval
  bisa menyusul di atas `ChannelManager`.
- **Sandboxing tool (#8)** — Damar sudah punya `toolGuard` (killSwitch/
  riskPolicy/pathPolicy); isolasi proses (docker) belum.
- **Compaction (#9)** — Damar masih jendela 20 giliran tetap; ringkasan
  iterative bisa dibangun di atas `SessionStore`.
- **SessionKey lintas-kanal (#5)** — grammar sudah ada; penyatuan sesi
  WhatsApp↔Telegram↔Console (kontinuitas lintas kanal) belum.
- **SKILL.md + command-dispatch** — Damar pakai `damarSkills` data-driven;
  format frontmatter OpenClaw bisa jadi evolusi berikutnya.

---

## 5. Verifikasi

- 23 test baru hijau (`tests/channels`, `tests/auth`, `tests/telemetry`).
- Smoke boot daemon: berhasil listen + "Kanal" tersambung tanpa galat.
- `/mcp` kini 401 tanpa token (sebelumnya terbuka); `/channels` dilindungi token.

> Catatan: suite penuh (`npm test`) menggantung pada tes `mcpClient`/`mlEngineer`
> yang menunggu proses anak (pre-existing, bukan dari evolusi ini).
