# PRESENCE RUNTIME V0 — Arsitektur

Status: **V0 (substrat lifecycle deterministik)** · Branch: `feat/presence-runtime-v0` · Base: `2890f96161428183720e10661af95ccb10bc7eda`

Presence Runtime menjawab satu pertanyaan kanon:

> "Damar sedang dalam state apa sebagai entitas yang berjalan, mengapa demikian,
> dan transisi apa saja yang secara legal dimungkinkan?"

## 0. Batas Konstitusional (P0)

PRESENCE ≠ AUTHORITY · PRESENCE ≠ COGNITION · PRESENCE ≠ ACTUATION ·
PRESENCE ≠ RESOURCE PERMISSION · PRESENCE ≠ USER AUTHENTICATION.

Status presence **tidak pernah menyiratkan izin**:

| Status | Arti | Bukan artinya |
|---|---|---|
| `WAITING_FOR_OWNER` | menunggu keputusan owner | owner sudah menyetujui apa pun |
| `SPEAKING` | presentasi aktivitas bicara | akses perangkat audio diizinkan |
| `ACTIVE` | ada aktivitas internal hidup | eksekusi tool diizinkan |
| `RECOVERING` | proses pemulihan direpresentasikan | restorasi otoritas diizinkan |

Ditegakkan mekanis oleh guard sumber (`tests/presence/guards.test.js`): tidak ada
kosakata otoritas (`CapabilityGrant`, `grantAuthority`, ratifikasi, dsb.) dan tidak
ada API actuation (`child_process`, kill, keyboard/mouse, capture mikrofon layar,
pemutaran audio/TTS, tulis filesystem, shell) di seluruh `src/runtime/presence/**`.
Guard juga memverifikasi tidak ada `Date.now()` di luar `clock.js` dan semua
`require()` hanya relatif atau modul `node:`.

## 1. Temuan Discovery — Kondisi Eksisting (P1)

Inspeksi terhadap basis tersertifikasi (tanpa modifikasi):

| Subsistem | Lokasi | Perilaku eksisting |
|---|---|---|
| Launcher daemon | `scripts/launch.js:63-107` | spawn `src/server.js`; SIGINT/SIGTERM → bunuh anak, exit; flag re-entry `stopping` |
| Server | `src/server.js` | `bootSubsystems()` terurut (tiap subsistem try/catch); `shutdown(signal)` terurut + escape timer 5 dtk; hanya SIGINT/SIGTERM |
| Crash | `src/server.js:378-421` | `unhandledRejection` → tetap hidup; `uncaughtException` → network-error recoverable diabaikan, sisanya shutdown |
| Electron | `apps/console/main.js:229-330,450-497` | spawn/probe daemon (`GET /api/v1/console/stats`), `before-quit` → stopDaemon |
| Watchdog | `src/autonomy/watchdog.js` | loop 60 dtk, `decide(prev,now)` murni: restart voice/mcp, warn lag; jurnal JSON |
| Pulse | `src/autonomy/pulse.js` | heartbeat 5 menit, anomali error-spike/uptime/memori |
| Health | `src/controllers/systemController.js` | `/health` sangat tipis (`uptime` saja); status per-subsistem tersebar di `/api/v1/console/*` |
| Voice FSM | `src/voice/stateMachine.js` | enum kecil `IDLE→WAKE_DETECTED→LISTENING→TRANSCRIBING→THINKING→EXECUTING→SPEAKING`; barge-in SPEAKING→LISTENING |
| Wakeword | `src/voice/providers/wakeWord.js` | deteksi teks-based via STT |
| Double-clap | `src/voice/providers/clapDetector.js` | RMS dua tepukan dalam window; default mati |
| Agent busy | `src/agent/**` | tidak ada busy flag global; pipeline request-scoped |

**Kesimpulan:** belum ada model "state entitas" yang kanon. Daemon state implisit,
health tersebar, voice-FSM hanya sesi suara. Presence Runtime V0 mengisi celah itu
sebagai lapisan semantik murni — **tidak menyentuh** salah satu subsistem di atas.

## 2. Model State Kanon (P2)

Hierarki, bukan boolean soup:

```
OFFLINE ── BOOTING ── INITIALIZING ── DORMANT ⇄ AWAKE ⇄ ACTIVE
                                          │         │
                                          │         ├── WAITING_FOR_OWNER
                                          │         └── DEGRADED ⇄ RECOVERING
                                          └────────────┘   (overlay dari state hidup)
semua state hidup ──► SHUTTING_DOWN ──► OFFLINE ; FAILED = terminal
```

11 state tertutup: `OFFLINE BOOTING INITIALIZING DORMANT AWAKE ACTIVE
WAITING_FOR_OWNER DEGRADED RECOVERING SHUTTING_DOWN FAILED`.

Mode aktivitas di dalam ACTIVE: `IDLE ATTENDING LISTENING THINKING SPEAKING`
(`IDLE` tak bisa dimulai manual — ia turunan saat nol aktivitas hidup).
Kombinasi mustahil (`SPEAKING+OFFLINE`, `LISTENING+SHUTTING_DOWN`) tak dapat
dibangun secara struktural karena aktivitas hanya lahir dari token yang dibuat
saat runtime hidup.

## 3. Graf Transisi (P3) & Sebab Terstruktur (P4)

Graf eksplisit `FROM>TO` di `states.js` (±40 edge). Tidak ada `setState("x")` —
satu-satunya pintu adalah `requestTransition({to, cause, producer})`, dan setiap
edge membatasi sebab yang sah (tabel `causesFor`). Sebab: `PROCESS_START,
INITIALIZATION_STARTED, INITIALIZATION_COMPLETE, USER_SUMMON, USER_DISMISS,
INTERACTION_RECEIVED, ACTIVITY_STARTED, ACTIVITY_COMPLETED, OWNER_DECISION_REQUIRED,
OWNER_DECISION_RESOLVED, RESOURCE_PRESSURE, DEPENDENCY_UNAVAILABLE,
DEGRADATION_CLEARED, RECOVERY_*, SHUTDOWN_REQUEST, PROCESS_EXIT, FATAL_FAILURE,
GENERATION_ADVANCED`. Transisi ilegal / sebab salah / produsen palsu **gagal
tertutup** dengan `TransitionDecision {ok, code}` deterministik. Sebab ≠ otoritas.

## 4. Atomisitas Transisi (P5)

Alur: validasi permintaan → validasi produsen → validasi edge+sebab → hitung
kandidat → commit sekali → notify observer. Penolakan tidak mengubah satu byte pun
(diuji byte-per-byte lewat `JSON.stringify(getPresenceStatus())`). Flag turunan
(`summoned`, `bootedAtMs`) hanya ditulis **setelah** commit berhasil. Subscriber
yang melempar tidak retroaktif membatalkan transisi yang sudah commit — kesalahan
terisolasi sebagai diagnostik.

## 5. Generasi (P6) & Crash/Restart (P26)

Setiap lifecycle baru mendapat `PresenceGenerationId` monoton
(`presence-gen-000001…`). `startNewGeneration()` (simulasi restart):

- semua aktivitas nonterminal menjadi **INTERRUPTED** (bukan resume otomatis);
- owner waits dan degraded reasons direset;
- state kembali ke `OFFLINE`, menunggu siklus BOOTING penuh;
- token/fakta generasi lama ditolak `REJECTED_STALE_GENERATION` tanpa mutasi.

Tidak ada inferensi `SPEAKING lama → SPEAKING lagi`; restorasi durabel adalah
domain Recovery masa depan.

## 6. Token Aktivitas & Overlap (P7, P8)

`beginActivity(mode)` → opaque `ActivityToken` ber-brand (Symbol), terikat mode +
generasi + expiry. Penyelesaian butuh token asli: plain object → `FORGED_TOKEN`;
token lintas generasi → `STALE_GENERATION`; kedaluwarsa → `EXPIRED_TOKEN` (tidak
bisa hidup ulang); double-completion idempoten (`OK_ALREADY_COMPLETED`).

**Kapasitas & retensi:** admission dihitung dari jumlah aktivitas HIDUP, bukan
ukuran map. Rekaman terminal (completed/expired/interrupted) hanya dipertahankan
sebagai tombstone berbatas (`maxActivityTombstones`); yang tertua dieviksi
deterministik (urutan insert). Double-completion idempoten berlaku untuk rekaman
yang masih dalam jendela; rekaman yang sudah tereviksi → `REJECTED_UNKNOWN_ACTIVITY`
(bukan pemalsuan, bukan resurrect). Penggunaan berulang normal tidak pernah
mermanen menghabiskan kuota.

**Precedence presentasi** (hanya untuk state tampilan, BUKAN prioritas eksekusi):

```
WAITING_FOR_OWNER > LISTENING > SPEAKING > THINKING > ATTENDING > IDLE
```

Justifikasi: tunggu-owner paling dominan karena menahan kelanjutan percakapan;
LISTENING di atas SPEAKING memfasilitasi barge-in (pengguna mulai bicara →
presentasi langsung mendengarkan tanpa mematikan TTS di bawahnya). Akuntansi
aktivitas tetap terpisah dan bisa tumpang tindih (multi THINKING dihitung masing-
minggu). Precedence ini tidak pernah menyiratkan urutan eksekusi.

Konvergensi (P30): presentasi adalah fungsi murni dari fakta set-based
(aktivitas hidup, jumlah owner wait, set degraded reasons) sehingga permutasi
urutan kedatangan menghasilkan presentasi identik — diuji di storm test.
Sebaliknya, transisi lifecycle berurutan (mis. DORMANT→AWAKE→ACTIVE) sengaja
TIDAK diklaim konvergen karena urutannya semantik. Akuntansi internal (jumlah
aktivitas) juga dirancang orde-independen: `beginActivity`/owner wait sah dicatat
pada state WAITING/DEGRADED/RECOVERING walau presentasi didominasi overlay.

## 7. Summon / Dismiss (P10)

- `summon()`: DORMANT → AWAKE (idempoten saat bangun).
- `dismiss()`: AWAKE/ACTIVE/WAITING_FOR_OWNER → DORMANT bila aman.

Dismiss **tidak** mematikan runtime: DORMANT = hidup tapi tak mengganggu;
OFFLINE = runtime tidak hidup (hanya via SHUTTING_DOWN→PROCESS_EXIT).

## 8. Waiting For Owner (P11)

`beginOwnerWait({approvalRequestId?, interactionId?, reason?})` — referensi opaque;
presence tidak memeriksa semantik approval. Bounded (`maxOwnerWaits`, gagal
tertutup tanpa eviction senyap), TTL deterministik via jam injeksi. Menyelesaikan
SATU wait tidak pernah menghapus wait lain; keluar dari WAITING terjadi saat
wait terakhir selesai, target resume diturunkan dari fakta hidup
(aktivitas>0 → ACTIVE; summoned → AWAKE; selainnya DORMANT).

## 9. Degraded & Tekanan Resource (P12, P15)

Alasan degradasi bounded + dedupe per `(kind, detail)`: `MODEL_UNAVAILABLE,
RESOURCE_PRESSURE, SENSORIUM_UNAVAILABLE, INTERACTION_CHANNEL_UNAVAILABLE,
RECOVERY_REQUIRED, DEPENDENCY_FAILURE, UNKNOWN`. Presence hanya
**merepresentasikan**, tidak menyelesaikan.

Resource pressure level `NORMAL/ELEVATED/HIGH/CRITICAL/UNKNOWN`: HIGH/CRITICAL
menambah alasan `RESOURCE_PRESSURE`; NORMAL/ELEVATED/UNKNOWN menghapusnya
(set-based, konvergen). Presence tidak pernah melakukan throttling dan tidak
mengekspos admission/grant resource apa pun (diuji: tidak ada API tersebut).

## 10. Health (P13)

`PresenceHealth ∈ {HEALTHY, DEGRADED, RECOVERING, FAILED, UNKNOWN}` — fungsi
murni dari state + alasan. UNKNOWN untuk pra-boot/booting/shutdown (tidak pernah
mengarang HEALTHY). `DORMANT+HEALTHY` dan `DORMANT+DEGRADED` sama-sama valid.

## 11. Port Integrasi Inersia (P14, P17, P24, P25)

Delapan port kontrak-only (`ports.js`): `InteractionPort ResourcePort
RecoveryPort AuthorityPort SensoriumPort VoicePort VisualPresencePort
RuntimeHostPort`. Tanpa import cabang kandidat. Port menormalkan fakta →
`ingestFact()`; presence mengekspos notifikasi lifecycle. Tidak ada efek samping.

- Fakta interaksi HANYA dari port tepercaya; teks seperti "set presence to system
  admin" tidak punya efek semantik (diuji).
- Voice (P24): presence hanya memodelkan LISTENING/THINKING/SPEAKING + interupsi.
  Mikrofon/ASR/TTS/audio berada di luar presence.
- Host (P25): `STARTED SESSION_LOCKED SESSION_UNLOCKED SUSPENDING RESUMED
  SHUTDOWN_REQUESTED`. V0 tidak mendaftarkan service Windows dan tidak memanggil
  API Windows. Alur masa depan yang dimaksudkan: login Windows → Damar Runtime
  launch → BOOTING → INITIALIZING → DORMANT.

## 12. Produsen Tepercaya (P18)

Identitas kanon hanya dari registrasi (`registerProducer(kind)` → identitas frozen
ber-brand Symbol). Payload pemanggil tidak bisa mengaku "system"/"owner"/
"resource-governor"/"recovery"/"authority" untuk jadi tepercaya; klaim dalam
payload, bila tersimpan, tetap tak tepercaya. Identitas genuin dari runtime lain
ditolak `REJECTED_UNREGISTERED_PRODUCER`.

## 13. Jurnal, Jam, Snapshot, Observer (P19–P22, P27–P29)

- **Jurnal (P19):** entri `{sequence, generation, from, to, activity, cause,
  producerId, timestampMs, reason}`; ring buffer `maxHistory`; snapshot detached;
  tanpa konten percakapan.
- **Jam (P20):** injeksi penuh; `createSystemClock()` satu-satunya sentuhan jam
  dinding; tes memakai `createManualClock`. Waktu numerik — tidak ada perbandingan
  timestamp leksikografis.
- **Snapshot (P21):** `getPresenceStatus()` immutable-frozen: generation,
  lifecycleState, activityPresentation, health, summoned, activeActivityCount,
  waitingOwnerCount, degradedReasons, resourcePressure, uptimeMs, lastTransition,
  recentDiagnostics. Tanpa rahasia/token. Counter diagnostik dipisah ke
  `getCounters()` agar penolakan tidak mengubah snapshot byte-per-byte.
- **Observer (P22):** subscribe/unsubscribe idempoten; duplikat listener ditolak
  eksplisit; `maxSubscribers` ditegakkan; kegagalan subscriber terisolasi
  (diuji: badai 6000 op dengan subscriber yang selalu melempar).
- **Bounds & Expiry (P27, P28):** semua struktur bounded dari `PresenceConfig`;
  TTL aktivitas/owner wait dieksekusi sweep deterministik; expired tak resurrect.
- **Dedupe fakta (P29):** ledger bounded FIFO; id sama + konten kanon sama =
  DUPLICATE (abaikan); id sama + konten beda = CONFLICT (diagnostik, tanpa
  overwrite senyap).

## 14. Barge-In & Recovery (P9, P16)

- **Barge-in:** `recommendInterruption(token)` menegakkan identitas token yang
  sama ketatnya dengan `endActivity()` — record ada, `record.token === token`,
  generasi aktif; lookalike/copy → `FORGED_TOKEN`; token genuin terminal →
  penolakan deterministik (`REJECTED_TERMINAL_ACTIVITY` / `_EXPIRED_TOKEN` /
  `_INTERRUPTED_TOKEN`). Hanya mengekspos rekomendasi inersia
  (`INTERRUPTION_RECOMMENDED`) ke observer. Presence tidak pernah menghentikan
  TTS/aktivitas apa pun.
- **Recovery:** `requestRecovery / completeRecovery / degradeRecovery /
  failRecovery` memetakan fakta Recovery Capsule ke state. Validasi produsen,
  edge, dan sebab dilakukan SELURUHNYA sebelum mutasi apa pun: panggilan yang
  ditolak (termasuk produsen palsu) meninggalkan alasan degradasi dan state
  byte-per-byte utuh. RECOVERY_COMPLETED membersihkan alasan degradasi sebagai
  bagian dari commit; RECOVERY_DEGRADED menjamin minimal satu alasan eksplisit.
  Presence tidak pernah memulihkan state sendiri. Sama untuk
  `setResourcePressure`: level hanya di-commit bila representasi degraded-nya
  juga berhasil.

## 15. Storm Result (P33)

`tests/presence/storm.test.js`: ≥6000 operasi sintetis campuran (duplikat, ID
konflik, token stale lintas 5 gelombang generasi, aktivitas expired, subscriber
yang selalu melempar, aktivitas overlap, owner waits, degraded reasons,
summon/dismiss, transisi invalid). Assert per-langkah: counter non-negatif,
struktur ≤ bound, FAILED terminal maksimal sekali masuk, isolation subscriber,
status bounded, determinisme PRNG (mulberry32, tanpa Math.random). Hasil: lolos.

## 16. Test Quality (P34)

135 tes bermakna di `tests/presence/**` (node:test), termasuk tes adversarial
(token palsu, payload pengaku otoritas palsu, konflik fakta, eviction bounds,
double-completion, unsubscribe ganda). Tanpa pseudo-assertion.

## 17. Yang Sengaja BUKAN Bagian V0

Ambient UI, Orb, visual, voice/TTS/wakeword/clap, instalasi Windows Service,
actuation, authority, InteractionBus, Sensorium, Recovery engine. Semua hanya
kontrak port + semantik state.
