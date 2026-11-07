# Runtime Host Wiring Map — pre-implementation study (Wave 3)

Base: 9d72965 (`integration: compose certified runtime foundations wave2`)
Branch: `integration/damar-runtime-host-v1`

## Current boot / process lifecycle

- `scripts/launch.js` spawns `node --use-system-ca src/server.js` (daemon) and,
  optionally, Console (`npm start --prefix apps/console`) as a *sibling* process.
- `src/server.js` → `app.listen()` → `bootSubsystems()` starts, each fail-graceful
  in try/catch: bootstrap banner, autonomy, MemoryService, consciousness, channels
  (whatsapp+telegram), schedulers (pulse/watchdog/dream), voice runtime (opt-in),
  aiRuntime, integrations polling, whatsappService, telegramService, automation,
  TerminalRuntime, crypto monitor/bot, MQTT home, `runtimeService.autostart()`,
  `ws/terminalGateway.attach(server)` (only WS gateway).
- Shutdown: single `shutdown(signal)` stops the same list, `server.close()` +
  5s hard exit. SIGINT/SIGTERM handlers present.
- **Console/Electron dependency: NONE in daemon.** Console is spawned by launcher
  only. `src/app.js` is express + MCP + OpenAI-compat bridge behind tokenGuard.

## Certified foundations (Wave 1 + 2)

- `src/integration/embodiedCore.js` — Wave 1: returns frozen `{ version, authority,
  body, desktop, reintel, acc (mode:"shadow"), damarSelf, observeEmbodiment,
  observeDesktop, feedCognition, describe }`.
- `src/integration/runtimeCore.js` — Wave 2 `createRuntimeCore()`: composes
  embodiedCore + ResourceGovernor + Recovery Capsule + InteractionBus + Presence
  Runtime; inert one-way pressure→presence port; deterministic idempotent
  `shutdown()`. **Currently wired nowhere** — no server/cli/bootstrap caller.
- Presence (`src/runtime/presence/presenceRuntime.js`) already owns canonical
  `boot/markInitializing/markInitializationComplete/summon(USER_SUMMON)/dismiss(
  USER_DISMISS)/beginActivity/endActivity/recommendInterruption/beginOwnerWait/
  resolveOwnerWait/reportDegradation/requestRecovery/failRecovery/
  reportFatalFailure/requestShutdown/confirmOffline/startNewGeneration/destroy`
  with legal-transition graph incl. `DORMANT→AWAKE`, `AWAKE|ACTIVE→DORMANT`,
  `RECOVERING→DORMANT`, `FAILED`, `SHUTTING_DOWN→OFFLINE`. Activity modes
  LISTENING > SPEAKING > THINKING > ATTENDING > IDLE support barge-in
  representation.
- InteractionBus (`src/runtime/interactionBus/`): `registerTransport(descriptor)`
  (origin from ORIGIN_SET incl. TELEGRAM/WHATSAPP/HOTKEY/OBSERVATORY/VOICE/API/
  SYSTEM/TEST; capability gates per kind), `submit(request)` normalizes into
  envelope w/ provenance `{transportId, origin, claimedIdentity}`, sessions,
  routing (CONVERSATION/COMMAND/APPROVAL/STATUS/CONTROL), bounded queues.
- Recovery (`src/runtime/recovery/`): `GenerationLedger` (current generation,
  `advance(reason)`, `assertCurrent(id)` throws E_STALE_RUNTIME_GENERATION),
  `RecoveryStatusTracker`, `checkpoint.createRecoverySystem()`, classification
  (RESUMABLE/NON_RESUMABLE), restore never decides authority.
- Authority (`src/authority/`): minting ONLY via
  `AuthorityRegistry.issueRatifiedRootGrant/delegate/ratify`. Read/enforcement:
  `authorize()`. Deny-by-default precedent test in wave2Invariants.

## Existing transports / channels

- Messaging intake: `channels.manager.register("whatsapp"|"telegram")` → services
  dispatch straight into `aiRuntime.chat(...)` (legacy path, bypasses
  InteractionBus entirely).
- AI connectors (`src/integrations/connectors/*`) are outbound LLM backends, not
  intake.
- Least invasive integration point for Wave 3: add an InteractionBus **adapter
  bridge** fed by thin hooks; do NOT rewrite channel architecture.

## Voice

- `src/voice/`: `VoiceRuntime` (start/stop/wakeDetect/clapDetect/listen/
  handleTranscript/speak/interrupt/status), `StateMachine` STATES =
  IDLE/WAKE_DETECTED/LISTENING/TRANSCRIBING/THINKING/EXECUTING/SPEAKING with
  barge-in `SPEAKING→LISTENING`; providers wakeWord/clapDetector/stt/tts as
  adapters; audio backend default "none"; opt-in via `DAMAR_VOICE_ENABLED=false`
  default. Wired in server boot try/catch.
- `docs/VOICE-RUNTIME.md`: voice is just another channel; standby makes zero LLM
  calls; graceful degradation; voice not trusted.
- No rate/pitch fields exist yet; TTS voice name from configs/env.

## Tray / hotkey

- No tray/hotkey/globalShortcut/RegisterHotKey code anywhere. Greenfield ports.

## Test conventions

- `node:test` + `assert/strict`, one process per file,
  `--require ./tests/helpers/testEnv.js` redirects state stores to temp dirs.
- Runner: `npm test` (all), suites under tests/{presence,interactionBus,recovery,
  resourceGovernor,authority,integration,...}.
- Fake clocks/injected observers pattern per `tests/integration/wave2Invariants.test.js`.

## Implications for Wave 3 design

1. Runtime Host wraps `createRuntimeCore()`; process-level phases (BOOT/
   INITIALIZE/RECOVER/READY/SHUTDOWN) live in the host; entity state stays
   canonical in Presence (no duplication of DORMANT/AWAKE).
2. summon/dismiss = thin semantic wrappers over `presence.summon/dismiss` using
   a trusted HOST producer; they grant nothing and revoke nothing.
3. New: `src/runtime/host/` with lifecycle, transport adapters (bus-only),
   hotkey/tray ports, voice contract module, standalone main entry.
4. Legacy server.js untouched; host runs independently of it.
