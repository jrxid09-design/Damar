# Voice Runtime — Always-On Assistant

Aether sebagai asisten suara always-on (FRIDAY/JARVIS/Siri), dibangun sebagai
**channel baru** menuju Aether Core — bukan otak AI kedua, bukan tool system
duplikat.

> Prinsip inti: Voice hanyalah salah satu interface (seperti Telegram/WhatsApp/
> Console/MCP). Ia memanggil `aiRuntime.chat({ channel: "voice", tools: undefined })`
> — jalur yang SAMA — sehingga ToolSelector, context budgeting, memory,
> consciousness/mind, MCP tools, dan audit trail SEMUA berjalan otomatis.

---

## Arsitektur

```
                    AETHER CORE (aiRuntimeService.chat)
                         │
        ┌────────────────┼────────────────┬───────────────┐
     Telegram        WhatsApp        Console         VOICE
                                                       │
                                        src/voice/
                                        ├─ voiceRuntime.js   orchestrator + loop
                                        ├─ voiceSession.js   jembatan ke aiRuntime
                                        ├─ stateMachine.js   lifecycle eksplisit
                                        ├─ config.js         env + JsonStore
                                        └─ providers/
                                           ├─ wakeWord.js     WakeWordProvider
                                           ├─ clapDetector.js deteksi "tepuk 2x"
                                           ├─ audioInput.js   mic abstraction
                                           ├─ audioOutput.js  speaker abstraction
                                           └─ vad.js          VAD (silence-based)
```

## Trigger wake (dua jalur)

Aether bisa "dipanggil" lewat dua trigger, keduanya lokal & tanpa LLM saat standby:

1. **Wake word** — kata panggil ("Aether"), lewat `WakeWordProvider`
   (keyword-match; engine lain bisa disisipkan).
2. **Tepuk tangan 2x (double clap)** — `ClapDetector`: dua ledakan suara
   pendek (transient) dalam jendela waktu singkat, diukur dari level audio
   (RMS 0..1). Bekerja di level audio, bukan transkrip — standby tetap
   tidak memanggil STT/LLM. Nonaktif secara default.

## State machine

```
IDLE → WAKE_DETECTED → LISTENING → TRANSCRIBING → THINKING
     → EXECUTING → SPEAKING → IDLE
```
- **barge-in**: `SPEAKING → LISTENING` (interupsi sah).
- **timeout**: `maxSessionMs` membatasi total giliran.
- **VAD**: `vadTimeoutMs` (diam = selesai bicara) + `maxListenMs` (jaring pengaman).

## Prinsip yang dipatuhi

1. **Aether Core independen dari UI** — Console boleh ditutup; voice daemon
   tetap hidup (bila diaktifkan).
2. **Standby tidak memanggil LLM/cloud** — hanya wake-word detection lokal.
3. **Acknowledgement deterministik** — `"Ya?"` dihasilkan lokal, tanpa LLM.
4. **Local-first** — STT/TTS lewat `voiceService` (faster-whisper, edge-tts/Kokoro).
5. **Graceful degradation** — mic rusak / STT mati / TTS mati / wake engine gagal
   → daemon TETAP hidup, channel lain tetap bekerja.
6. **Tidak ada dependency native audio** — backend audio default `none`; `cli`
   memakai perintah OS (arecord/sox/PowerShell) bila diaktifkan eksplisit.
7. **Safety tetap berlaku** — perintah suara masuk lewat ToolRegistry → toolGuard/
   riskPolicy/audit yang sama. Voice bukan "trusted channel" yang bebas.
8. **Model tidak di-hardcode** — wake word, STT, TTS semuanya lewat provider/config.

## Konfigurasi (env, semua opsional)

| Env | Default | Arti |
|---|---|---|
| `AETHER_VOICE_ENABLED` | `false` | Aktifkan voice runtime |
| `AETHER_WAKE_WORD` | `aether` | Kata panggil |
| `AETHER_VOICE_WAKE_PROVIDER` | `local` | Engine wake-word (keyword-match) |
| `AETHER_VOICE_STT_PROVIDER` | `local` | STT (lewat voiceService) |
| `AETHER_VOICE_TTS_PROVIDER` | `local` | TTS (lewat voiceService) |
| `AETHER_VOICE_MAX_SESSION_MS` | `60000` | Batas total satu giliran |
| `AETHER_VOICE_VAD_TIMEOUT_MS` | `1200` | Diam = selesai bicara |
| `AETHER_VOICE_MAX_LISTEN_MS` | `10000` | Jaring pengaman rekaman |
| `AETHER_VOICE_AUDIO_BACKEND` | `none` | `cli` untuk mic/speaker OS |
| `AETHER_VOICE_ACK` | `Ya?` | Acknowledgement deterministik |
| `AETHER_VOICE_LANGUAGE` | `id` | Bahasa STT |
| `AETHER_VOICE_CLAP_ENABLED` | `false` | Aktifkan trigger tepuk 2x |
| `AETHER_VOICE_CLAP_THRESHOLD` | `0.6` | Level RMS (0..1) = "bunyi keras" |
| `AETHER_VOICE_CLAP_WINDOW_MS` | `800` | Jendela maks antar dua tepukan |
| `AETHER_VOICE_CLAP_MIN_CLAP_MS` | `30` | Lebar minimum satu tepukan |
| `AETHER_VOICE_CLAP_MIN_GAP_MS` | `100` | Jeda minimum antar tepukan |

STT/TTS tetap membaca `AETHER_STT_URL` / `AETHER_TTS_URL` (endpoint
OpenAI-compatible, local-first) — tidak ada konfigurasi suara baru yang
mendobel `voiceService`.

## Status / observability

`GET /api/v1/console/voice/status` (rute existing, diperluas) kini mengembalikan
`runtime`:

```json
{
  "enabled": false, "state": "idle", "wakeWord": "aether",
  "clapEnabled": false,
  "clapDetector": { "provider": "local", "threshold": 0.6, "windowMs": 800 },
  "microphone": { "backend": "none", "available": false },
  "speaker":    { "backend": "none", "available": false },
  "sttProvider": "local", "ttsProvider": "local",
  "wakeWordProvider": { "provider": "local", "wakeWord": "aether" },
  "activeSession": null
}
```

## Test

`tests/voice/voiceRuntime.test.js` — 30 test: transisi state (legal & ilegal),
barge-in, wake word (utuh vs substring), deteksi tepuk 2x (2 dalam jendela vs
1/terlalu jauh/bunyi panjang/noise), VAD (diam/touch), graceful degradation
(mic/STT/TTS/model gagal), dan **VoiceSession memakai jalur aiRuntime yang sama**
(`tools: undefined` → ToolSelector otomatis, `channel: "voice"`).

## Peta lanjutan

1. **Wake-word engine sungguhan** (Porcupine/Vosk/openWakeWord) — sisipkan
   implementasi `WakeWordProvider` baru, set `AETHER_VOICE_WAKE_PROVIDER`.
2. **STT streaming** + **VAD berbasis level audio** (RMS) saat backend audio
   `cli` tersedia.
3. **TTS streaming/chunked** — mulai bicara sebelum respons penuh selesai.
4. **Wake-word dari mic terus-menerus** (loop rekam pendek → STT ringan → wake
   detect) — saat ini `wakeDetect(text)` tersedia sebagai API; integrasi mic
   standby bisa menyusul di backend `cli`.
