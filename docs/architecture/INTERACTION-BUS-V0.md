# InteractionBus V0 — Canonical Interaction Substrate

Status: **V0 core, additive, zero-authority, zero-actuation**
Location: `src/runtime/interactionBus/`
Tests: `tests/interactionBus/`
Branch: `feat/interaction-bus-v0`

---

## 1. Constitutional law

**INTERACTION != AUTHORITY.**

InteractionBus carries user intent, authentication *evidence*, session metadata,
context references, authority decision *references*, and approval
requests/results. It never grants anything.

InteractionBus MUST NOT (and structurally does not):

- grant authority or create capability grants
- fabricate owner identity, roles, or superadmin status
- treat any transport (Telegram / Console / voice) as implicitly trusted
- execute tools, shell commands, or device actuation
- mutate cognition, ACC, or Authority state
- silently retry material actions

Authentication evidence is **input** to a future Auth/Authority integration.
It is never authority itself. These properties are enforced mechanically by
structural scan guards (`tests/interactionBus/zeroGuards.test.js`) over the
production sources.

## 2. I0 — Discovery of existing flows (as-built)

Findings from the certified base (`2890f96161428183720e10661af95ccb10bc7eda`):

| Area | Location | Notes |
|---|---|---|
| Chat controller/service | `src/controllers/chatController.js`, `src/services/chatService.js` | Legacy path; builds `AgentContext`, runs agent |
| Production AI chat | `src/controllers/aiController.js`, `src/services/aiRuntimeService.js` | `chat()` / `stream()`; channel derived from body/header; identity synthesized as `` `${channel}:${model}` `` fallbacks |
| Console routes | `src/routes/api/v1/console.js` | `POST /chat`, `POST /ai/chat`, `POST /ai/stream`, telemetry SSE `GET /events` |
| SSE streaming | `aiController.stream` (hand-rolled `text/event-stream`), also `orchestratorController`, `companion/deviceController.chatStream` | Four independent copies of the same SSE pattern; Express-5 `res.on("close")` idiom |
| Telegram transport | `src/services/telegramService.js` | Raw Bot API long-polling, allowlist chat ids, TOTP-gated "full mode", sessions keyed `telegram:${chatId}`, role from full-mode state |
| WhatsApp transport | `src/services/whatsappService.js` | Baileys; group gating on mention/reply; roles via `roleService`; session keys `channel:whatsapp:{dm\|group}:<jid>` |
| Agent request objects | `AgentContext` (legacy), aiRuntime request `{messages, model, channel, role, signal, sessionId, contextRefs}` | Several shapes coexist |
| Session IDs | Not UUIDs; parseable string keys `channel:<channel>:<kind>:<peer>` (`src/channels/sessionStore.js`), SQLite-backed | HTTP fallbacks like `console:cli` |
| Correlation IDs | `crypto.randomUUID()` used in cognition envelope, substrate router, companion pairing | No shared correlation across transports |
| Cancellation | Client-disconnect flags only (`res.on("close")`); deeper plumbing via `TurnController` `{signal}` and `AbortSignal.timeout` | No cancel endpoints; no cross-subsystem cancellation protocol |
| Event buses | `src/events/eventBus.js` (EventEmitter singleton), `telemetryService` publish/subscribe backing `/events` SSE | Telemetry is log-flavored, not interaction routing |
| Tool result streaming | Whole tool-call announcements inside AI stream chunks (`RuntimeExecutor.streamExecute`) | No canonical stream event model |
| Message schemas | `src/validators/chatValidator.js` (express-validator), ad-hoc body destructuring elsewhere | No closed enums |

### Existing closest analogs

1. `src/channels/channelManager.js` + `sessionStore.js` — deliberately built as
   "the uniform interface for all message paths". This is a **channel/session
   persistence layer**, not a routing bus: no envelopes, no closed kinds, no
   provenance separation, no cancellation protocol.
2. `src/cognition/core/envelope.js` — strict frozen event envelope with
   canonical JSON + SHA-256 digest. This is the **ACC cognition bus**, internal
   to cognition; user-chat traffic does not flow through it.

### Verdict

No canonical bus exists. Nothing should be force-migrated in V0. The correct
move is a new, transport-neutral substrate that future adapters plug into.

### Migration path (future, not in V0)

1. Transports keep their ingress code but construct an `InteractionEnvelope`
   via `bus.submit(...)` instead of calling `aiRuntimeService.chat/stream`
   directly.
2. A CONVERSATION route handler wraps `aiRuntimeService.chat/stream`; the SSE
   controllers become thin subscribers of the canonical stream events
   (START/DELTA/STATUS/APPROVAL_REQUIRED/FINAL/ERROR/COMPLETE map 1:1 onto the
   existing `start`/`chunk`/`done`/`error` SSE frames).
3. Telegram's TOTP flow stops assigning roles itself; it emits AUTH_EVIDENCE
   interactions and consumes whatever decision a future Auth subsystem publishes.
4. Channel session keys gain a canonical `ses_*` alias at registration time;
   `sessionStore` remains the durable store behind the SessionRecord refs.

## 3. I1 — Canonical model (closed enums)

All enums are frozen arrays + frozen lookup sets in `enums.js`. No arbitrary
strings are accepted where closed semantics are required.

- `INTERACTION_ORIGINS`: VOICE, PRESENCE, HOTKEY, OBSERVATORY, TELEGRAM, WHATSAPP, API, SYSTEM, TEST
- `INTERACTION_KINDS`: MESSAGE, COMMAND, APPROVAL_RESPONSE, CANCEL_REQUEST, STATUS_REQUEST, CONTEXT_REFERENCE, AUTH_EVIDENCE, EVENT
- `INTERACTION_STATES`: RECEIVED, VALIDATED, QUEUED, DISPATCHED, STREAMING, COMPLETED, CANCEL_REQUESTED, CANCELLED, FAILED, EXPIRED
- `RESPONSE_KINDS`: TEXT_DELTA, TEXT_FINAL, VOICE_HINT, STATUS, APPROVAL_REQUIRED, ERROR, COMPLETE

## 4. I2 — Canonical IDs (`ids.js`)

| Type | Grammar | Max total length |
|---|---|---|
| InteractionId | `ix_` + `[a-z0-9][a-z0-9_-]{0,62}` | 67 |
| SessionId | `ses_` + same segment | 67 |
| CorrelationId | `cor_` + same segment | 67 |
| TurnId | `trn_` + same segment | 67 |
| RuntimeGenerationId | `gen_` + same segment | 67 |
| TransportId | `[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){0,7}` (e.g. `telegram.primary`) | 64 |
| AttachmentId / EvidenceId | `att_` / `evd_` + segment | 67 |

Properties:

- explicit grammar, explicit total length limits; malformed IDs reject with `INVALID_ID`
- no `/`, `\`, whitespace, dots (except single dots between transport-id segments), so **no path semantics**
- byte-exact comparison; **no case normalization**, so `IX_A` and `ix_a` are different IDs and cannot collide through normalization
- storage uses `Map` exclusively; IDs never become object keys, so prototype keys (`__proto__` etc.) are structurally irrelevant; metadata-like records additionally reject those key names outright
- IDs carry **no privilege meaning**: `"admin-123"` parses identically to `"user-123"` and grants nothing

Factories: `createSequentialIdFactory(seed)` (tests, deterministic),
`createCryptoIdFactory()` (production, `node:crypto` randomness at the boundary).

## 5. I3/I4 — Envelope & trusted vs claimed identity (`envelope.js`)

The canonical `InteractionEnvelope` is deep-frozen and exact-schema validated:

```
schemaVersion, interactionId, sessionId, turnId?, correlationId?,
origin, kind, receivedAt, payload, contextRefs[], authEvidenceRefs[],
metadata{}, deadline{at, expiredAtReceipt}?, generation?,
provenance{transportId, origin, claimedIdentity{}, claimedMetadata{}}
```

Unknown envelope fields reject (`ENVELOPE_FIELD_FORBIDDEN`). Payloads are
validated against closed per-kind schemas (`payloads.js`) — privileged-looking
fields such as `role`, `superadmin`, `authority`, `trusted`, `owner` are
**unknown fields** and are rejected with `PAYLOAD_FIELD_FORBIDDEN`. They can
never become trusted state.

**Provenance derives from the registered transport instance only.** The origin
on the envelope must equal the origin registered for `provenance.transportId`;
caller-supplied origins are ignored entirely. Anything the caller *claims*
(`claimedIdentity`, `claimedMetadata`) is stored separately under
`provenance`, bounded, and never consulted for routing, authority, or trust
decisions. Same principle as a network socket: the packet does not decide which
trusted interface received it.

## 6. I5 — Transport registration (`transports.js`)

Explicit, code-level registration only:

```js
bus.registerTransport({
  transportId: "telegram.primary",
  origin: "TELEGRAM",
  capabilities: { acceptsText: true, supportsCancellation: true }
});
```

Capabilities: `acceptsText`, `acceptsCommands`, `supportsStreaming`,
`supportsCancellation`, `supportsApprovalResponses`, `supportsBinaryAttachments`,
`supportsVoiceHints`, `acceptsAuthEvidence`, `acceptsEvents`.

Kind emission contract (fail closed, `CAPABILITY_VIOLATION` with explicit
missing-capability detail):

| Kind | Requires |
|---|---|
| MESSAGE, CONTEXT_REFERENCE | acceptsText |
| COMMAND | acceptsCommands |
| CANCEL_REQUEST | supportsCancellation |
| APPROVAL_RESPONSE | supportsApprovalResponses |
| AUTH_EVIDENCE | acceptsAuthEvidence |
| EVENT | acceptsEvents |
| STATUS_REQUEST | (none) |

There is no API that accepts a serialized transport name; modules are never
loaded dynamically from input.

## 7. I6 — Canonical payloads (`payloads.js`)

Validated, deep-frozen, byte-bounded payloads:

- **MessagePayload**: `text` (1..maxTextChars), optional `language`, `attachments[]` (descriptors only), `replyToInteractionId`, `referenceIds[]`
- **CommandPayload**: `command` (bounded token), `arguments[]`, `namedArguments{}` — a command name is inert data; nothing in InteractionBus maps names to code
- **CancelPayload**: `targetInteractionId`, `reason?`
- **ApprovalResponsePayload**: `approvalRequestId`, `decision: approve|reject`, `note?` — carried verbatim; never interpreted
- **StatusRequestPayload**: `scope: SESSION|GLOBAL`, `includeDetails`
- **AuthEvidencePayload**: opaque `{provider, evidenceId, issuedAt, expiresAt}`
- **EventPayload**: `eventType`, bounded `attributes{}`
- **ContextReferencePayload**: `{reference: {type, ref}}`

Attachment descriptors: `attachmentId`, RFC-token `mediaType`, `sizeBytes`,
opaque `contentRef` (no slashes, no `..`), display-only `name` (path
separators, control chars, leading dots rejected). No filesystem paths from
callers, no opening, fetching, or execution — there is no filesystem access in
the module at all.

## 8. I7/I8 — Sessions & hijack protection (`sessions.js`)

A session is a conversation/routing scope. It is not identity, not
authentication, not authority. `SessionRegistry.ensure(sessionId, origin,
transportId)` binds transport identity **immutably at creation**. Any later
submission for that sessionId from a different transportId (or origin) fails
closed with `SESSION_TRANSPORT_MISMATCH`. Cross-transport joining never happens
automatically in V0; a future explicit authenticated linking capability would be
a separate, deliberate API. Sessions idle past `sessionIdleTTLms` are swept
(`CLOSED_IDLE`).

## 9. I9/I10 — Routing & handlers (`routing.js`)

Deterministic kind→route mapping (no LLM, no string→method dispatch):

MESSAGE, CONTEXT_REFERENCE → CONVERSATION · COMMAND → COMMAND ·
APPROVAL_RESPONSE → APPROVAL · STATUS_REQUEST → STATUS · EVENT, AUTH_EVIDENCE → CONTROL

Handlers are code-registered per route with explicit `supportedKinds`.
Registration validating that each kind canonically routes to the declared route.
Two handlers claiming the same kind on one route fail registration with
`HANDLER_AMBIGUOUS` (default policy `reject`), or resolve deterministically
under the explicit `highest-priority` policy (priority desc, then registration
order). No material command is ever fanned out to multiple handlers: exactly
one handler resolves per kind.

## 10. I11 — Zero execution

Production V0 handlers are inert. InteractionBus contains no imports or calls
into RuntimeExecutor, ToolBus, child processes, devices, Home Assistant, or any
execution substrate. Verified by structural guard tests.

## 11. I12 — Streaming (`streams.js`)

Canonical stream events: START, DELTA, STATUS, APPROVAL_REQUIRED, FINAL, ERROR,
COMPLETE. State machine over `idle → started → finalized → completed`, plus
terminal `failed`:

- START ≤ 1 (from idle)
- DELTA / STATUS / APPROVAL_REQUIRED require started, before FINAL
- FINAL ≤ 1 (started → finalized)
- ERROR ≤ 1, terminal (from idle/started/finalized)
- COMPLETE exactly once, requires finalized (finalized → completed)

Any invalid transition throws `STREAM_INVALID_TRANSITION` (surfaced as
diagnostics, failing only that interaction). No DELTA after terminal states.

Slow consumers: subscribers may `pause()`; paused delivery buffers up to
`maxStreamBufferEvents`, beyond which the stream fails with
`STREAM_BUFFER_OVERFLOW` (counted) and the subscription closes — buffers can
never grow unboundedly.

## 12. I13/I14 — Backpressure & fairness (`config.js`, bus core)

Central frozen bounds: `maxSessions`, `maxPendingInteractions`,
`maxPendingPerSession`, `maxInFlightPerSession`, `maxStreamBufferEvents`,
`maxPayloadBytes`, `maxTextChars`, `maxMetadataBytes`, `maxMetadataKeys`,
`maxContextRefs`, `maxAuthEvidenceRefs`, `maxAttachments`, `maxCommandArgs`,
`maxClaimedFields`, `maxSessionHistory`, `maxDiagnostics`, `maxDedupeLedger`,
`interactionTTLms`, `sessionIdleTTLms`.

All queues/maps are bounded. Over-limit submissions fail closed (`QUEUE_FULL`,
`SESSION_QUEUE_FULL`, `SESSION_LIMIT_EXCEEDED`). Scheduling is deterministic
round-robin across sessions in stable creation order, FIFO within a session:
one noisy session gets at most one dispatch per pass and cannot starve others.

## 13. I15 — Duplicate / replay semantics

Every envelope has a canonical digest (sorted-key JSON of
`{interactionId, sessionId, kind, payload}`, SHA-256):

- same ID + same digest → `DUPLICATE` rejection referencing original state
- same ID + different digest → `CONFLICTING_INTERACTION`; never overwritten

The dedupe ledger is FIFO-bounded at `maxDedupeLedger`; eviction emits a
`DEDUPE_LEDGER_EVICTED` diagnostic. After eviction, replay of that ID is
treated as a brand-new interaction (documented, deterministic behavior).

## 14. I16/I17 — Cancellation & barge-in foundation

`bus.requestCancellation({transportId, sessionId, targetInteractionId, reason})`
is a REQUEST. The target must exist and belong to the requesting
transport+session; otherwise the answer is the explicit deterministic result
`TARGET_NOT_FOUND` (existence is not leaked). Effects:

- STREAMING/DISPATCHED target → state `CANCEL_REQUESTED`, its stream receives a
  STATUS event `{cancelRequested:true}`
- QUEUED target → flagged; at dequeue it becomes `CANCELLED` without dispatch
- repeated requests are idempotent; already-terminal targets report current state

Only a handler may acknowledge via `ctx.acknowledgeCancellation()` →
`CANCELLED`. InteractionBus never kills processes, never touches foreign
AbortControllers, never terminates tools.

Barge-in foundation: voice transport sends CANCEL_REQUEST then submits a new
MESSAGE. Both interactions keep independent IDs, histories, and streams; both
remain separately traceable end-to-end (proven in tests).

## 15. I18 — Approval flow foundation

APPROVAL_REQUIRED stream events and APPROVAL_RESPONSE interactions are pure
data routed to the APPROVAL route. `decision:"approve"` is carried verbatim;
InteractionBus does not interpret it, does not create grants, and executes
nothing after approval. A future Authority subsystem independently validates.

## 16. I19 — Auth evidence foundation

V0 models opaque evidence references `{provider, evidenceId, issuedAt,
expiresAt}` on AUTH_EVIDENCE interactions / `authEvidenceRefs`. Strict schema:
any extra field (tokens, codes, secrets) rejects. No TOTP validation, no OAuth,
no authentication declarations, no role production — ever — inside this module.

## 17. I20 — Response routing

Streams are created per-interaction at dispatch and handed only to the handler
context; the submitting transport holds the subscription it opened at submit
time. There is no global response channel; a response physically cannot reach a
different session's subscriber. Tests prove Telegram-session-A responses never
appear on Console-session-B collectors, with distinct correlationIds enforced.

## 18. I21–I23 — Attachments, deadlines, generations

See §7 for attachment descriptors.

Deadlines: epoch-ms integers or ISO-8601 strings parsed with `Date.parse`
(real time semantics, never lexicographic comparison). Expired-at-receipt
interactions enter the ledger as `EXPIRED`; queued/dispatched ones expire at
dispatch check, TTL check, or `bus.sweep(now)`. Expiry never resurrects
(ledger digest persists until bounded eviction).

RuntimeGenerationId (`gen_*`) is a local, validated ID format conceptually
compatible with a future Recovery Capsule. Responses/staleness accounting
counts `staleGenerationResponses` when a stale generation would attach to a
newer interaction generation; no Recovery candidate code is imported.

## 19. I24/I25 — Observability & privacy

`bus.getStatus()` returns a frozen read-only snapshot: active sessions, pending
interactions, inflight, active streams, per-state counts, per-origin counts,
accepted/rejected/duplicate/conflict/completed/failed/cancelled/expired counts,
bounded recent diagnostics (`interactionId`, `reason`, bounded reason strings,
timestamp). Default diagnostics contain **no message text**; conversation
persistence belongs elsewhere. Secrets, TOTP values, auth-evidence contents,
and attachment content never appear anywhere in telemetry.

## 20. I26 — Determinism

The core contains no hidden `Date.now()` / `Math.random()`. Clock and ID
factory are injected. With a fixed clock and sequential ID factory, identical
interaction sequences produce identical routing decisions, state transitions,
and identical `getStatus()` snapshots (proven by JSON-equality storm runs).

## 21. I27–I28 — Failure isolation & disconnect

A throwing/rejecting handler fails only its own interaction (diagnostic +
FAILED); queue, session, and other sessions progress unaffected. A throwing
response subscriber is isolated during fanout and cannot retroactively change
canonical interaction state.

Transport disconnect marks its sessions DETACHED (same-transport resume is
allowed until idle sweep; different transports still cannot bind them).
Pending-interaction policy: **keep until TTL** — deterministic, documented;
pending items remain individually cancellable and expirable. No silent rebinding,
no privilege carryover to reconnecting clients beyond the fixed transport binding.

## 22. I29/I30 — Structural zero-authority / zero-actuation guards

`tests/interactionBus/zeroGuards.test.js` scans every production file under
`src/runtime/interactionBus/**` and asserts absence of authority fabrication
(grant creation, superadmin/role-system fabrication, TOTP/OAuth handling,
ToolBus/RuntimeExecutor invocation) and actuation (child processes, process
signals, fs writes, dynamic code execution, shell invocation, keyboard/mouse/
screen control, browser/ADB/Home-Assistant control, network listeners).

## 23. I31 — Storm

`storm.test.js` drives ≥2000 interactions across VOICE, TELEGRAM, OBSERVATORY,
API, HOTKEY origins over many sessions including duplicates, conflicts,
expired requests, cancellations, handler failures, and slow (paused)
consumers, asserting: all buffers bounded, no cross-session leakage, no
negative counters, no double-terminal transitions, bounded dedupe ledger and
diagnostics, fair per-session progress, and bit-identical deterministic final
status across two identical runs.

## 24. I33/I34 — Future contracts & target experience

Inert adapter classes (`futureTransports.js`): `VoiceTransport`,
`TelegramTransport`, `ObservatoryTransport`, `PresenceTransport`,
`HotkeyTransport` — lifecycle `register → start → emit → respond → disconnect →
stop`, all `NOT_IMPLEMENTED` until their milestone. No networking ships here.

Target flows:

- **Voice**: mic wakeword → VoiceTransport.emit(MESSAGE, VOICE) → InteractionBus →
  cognition/runtime handler → streaming TEXT_DELTA…FINAL → Presence surface +
  TTS render. User barge-in: CANCEL_REQUEST(old ix) + MESSAGE(new ix); old and
  new stay separately traceable.
- **Telegram superadmin onboarding**: `/superadmin` → TelegramTransport →
  InteractionBus(AUTH_EVIDENCE) → Auth validates → Authority decides → domain
  service verifies → response routed back only to the originating Telegram
  session. InteractionBus never becomes the authorization shortcut.
