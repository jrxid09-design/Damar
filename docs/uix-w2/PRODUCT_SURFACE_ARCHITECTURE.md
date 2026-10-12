# DAMAR UIX-W2 Product & Surface Architecture

Status: architecture candidate; not final certification or freeze.

## Frozen input and invariant

W1 baseline: `660d342e8ab3b8012d5c503ee7e5242c3b497540`.
W1 is immutable input. W2 is a documentation-only delta. The product invariant is **one Damar, one identity, one continuity model, one authority model, multiple surfaces**.

Frozen facts carried forward: 42 canonical capabilities; one authority model; 9 canonical channels and 7 currently user-reachable channels; 5 provider/model records; Mata Dewa is the canonical runtime subsystem; Sensorium and Observation-to-Context are implemented and verified; Dashboard is designed/not implemented; Idle/Presence has an implemented internal runtime foundation but no visual/product shell; Legacy Console is retired/deleted; `terminal_websocket` is not user reachable; `llamacpp` is current provider truth with partial runtime reachability.

## Surface topology

Surfaces are projections and ingress boundaries, never independent Damars. The primary experience is Idle/Presence. The Web Dashboard is the secondary control plane. CLI is first-class operational access. Voice, Telegram, WhatsApp, Companion, HTTP/API, MCP, and Remote Mesh are bounded interaction surfaces. `terminal_websocket` remains a future/partial boundary and is not a current surface attachment.

### Idle / Presence

Owns the near-user experience: presence, standby, summon/wake, conversation, current activity, quick approvals, important alerts, mission/security summaries, lightweight device/context state, notification presentation, and handoff. It must not own missions, authority, providers, audit, capability/device/model registries, or security policy. Visual presence states are projections of read models and runtime signals.

### Web Dashboard

Secondary control plane for configuration, manual operations, monitoring, deep inspection, missions, devices, capabilities, memory/context, learning/evolution, Mata Dewa awareness, DCD/security, models/providers, gateways/integrations, authority views, runtime, audit, and forensic workflows. It is not runtime, authority, or a public service by default. Initial deployment is local-first with a real auth/session boundary before broader exposure. Dashboard closure does not stop Damar.

Canonical IA groups: Overview; Presence; Missions; Devices; Capabilities; Memory & Context; Learning & Evolution; Awareness (Mata Dewa/Sensorium); Security (DCD); Models & Providers; Gateways & Integrations; Authority; System & Runtime; Audit; Developer/Forensic. These are navigation projections, not ownership boundaries.

### Other surfaces

CLI supports both human and machine-readable operations, sessions, missions, devices, provider/model administration where existing APIs permit, approvals, and forensic output. Voice is the same identity in an audio mode, with wake/summon, confirmation, failure fallback, and visual handoff. Telegram/WhatsApp provide conversation, remote mission/status interaction, notifications, and bounded safe approvals; they do not store mission/memory/authority truth. Companion extends presence, notifications, approvals, device/sensor contribution, and remote summon without independent authority. HTTP/API is a contract boundary, MCP is governed external tool exposure, and Remote Mesh is a trusted distributed-device transport with canonical device identity. Neither external agents nor tools become orchestrators.

## Canonical command flow

`surface intent -> canonical command/action request -> Manager/orchestration -> existing authority evaluation -> capability/actuation -> verification -> audit -> read-model/event update -> surface projection`.

UI, button, voice command, chat message, CLI command, API key, background service, model choice, autonomy, detection, and notification are never authority. Consequential requests expose risk, required approval, authority decision, verification state, uncertainty, and compensation/cancel options. Approval decisions use the same canonical approval record on every surface.

## Continuity and identity

`damar_id` is singular. `user_id`, `surface_instance_id`, and authenticated `session_id` identify access context; `conversation_id` groups dialogue; `mission_id` outlives a surface; `task_id` identifies a mission unit; `approval_id` identifies one decision; `notification_id` identifies one notification; `device_id` identifies a paired or observed device. Handoff passes IDs and a read-model cursor/deep link, never copied mutable state. A conversation may reference many missions, and a mission may be continued by many surface sessions.

## Read models and freshness

Backend-owned read models are the only surface input. Shared projections include identity/session, conversation, mission/task, approval, notification, presence, device, capability, memory/context, awareness, security incident, provider/model, gateway key metadata, and audit. Surface projections may choose fields and density but cannot rewrite facts. Reads declare `as_of`, revision/cursor, freshness class (`LIVE`, `EVENTUAL`, `STALE`, `UNKNOWN`), provenance, and redaction. Lists paginate by stable cursor. Snapshots establish a baseline; streams carry ordered changes with resync on gap. Unknown/stale data is shown as unknown/stale, never inferred as healthy or complete.

## Presence and interruption

Canonical product-facing projection states: DORMANT, IDLE, LISTENING, THINKING, ACTING, WAITING_FOR_USER, WAITING_FOR_AUTHORITY, VERIFYING, COMPLETED, FAILED/DEGRADED, ATTENTION, SECURITY_ALERT, OFFLINE. They derive from runtime/session/mission/approval/provider/security read models; no visual-only state is persisted as runtime truth. Interruption levels are SILENT, PASSIVE, NORMAL, IMPORTANT, URGENT, CRITICAL. Policy maps events to update, notify, speak, require approval, or cross-device escalation. Privacy, quiet hours, surface availability, and security policy gate delivery. Notification delivery is not proof of authority or completion.

## Mission, memory, awareness, and security boundaries

Mission fields are canonical ID, goal/title, owner, timestamps, origin, state, tasks/current step, approvals, devices/capabilities, model routing reference, progress, verification, result/failure, and audit references. Product states are CREATED, PLANNING, READY, RUNNING, WAITING_FOR_USER, WAITING_FOR_AUTHORITY, BLOCKED, VERIFYING, COMPLETED, FAILED, CANCELLED, DEGRADED, only where derivable from W1/runtime contracts.

Memory UI distinguishes conversation context, durable memory, experience, learning signal, world model, editable profile/preferences, and audit history. Evolution shows proposal, evidence, evaluation, approval, deployment, and rollback; proposal is never mutation. Capability views preserve exists/registered/composed/runtime-reachable/user-reachable/governed/tested/certified distinctions. Mata Dewa presents current bounded awareness, observed devices/spatial/host context, request provenance, freshness, and sensor availability; it does not claim continuous vision, OCR, window capture, GEV rendering, or cockpit perception. DCD presents signals, detections, incidents, analysis, simulation, response proposals, posture, evidence, and history; detection never authorizes response.

## Model/provider and gateway architecture

The future Model Registry separates canonical model identity from provider instance. A record may include capabilities, context length, modality, health, cost metadata, role suitability, assignment, and gateway exposure. Provider type and provider instance are distinct; instances support multiple endpoints/accounts/keys, including OpenAI-compatible local and remote endpoints. W1 records remain exactly: `openrouter`, `provider-federation`, `connectors`, `mata-dewa`, `llamacpp`; `llamacpp` remains PARTIAL.

Future provider health states: UNKNOWN, HEALTHY, DEGRADED, RATE_LIMITED, QUOTA_EXHAUSTED, AUTH_FAILED, UNREACHABLE, DISABLED. Health and quota inform routing, not authority. A role route is `logical alias -> candidate model/provider instances -> health/quota filters -> weighted/round-robin/fallback decision`. Aliases such as `damar-general`, `damar-fast`, `damar-reasoning`, `damar-code`, and `damar-vision` are routing labels, not provider identities.

Model Gateway exposes inference only. Agent Gateway exposes governed Damar workflows/capabilities and always enters Manager and authority for consequential work. Downstream keys are scoped metadata plus Secret Vault reference: allowed models/aliases, rate limit, finite/unlimited token quota, expiry, network restrictions, enabled/revoked state, usage accounting. Valid credentials and unlimited quota do not grant authority. Key rotation/revocation never reveals secrets.

## Security, privacy, and degraded behavior

Local trusted desktop, browser, CLI, remote chat, companion, Model Gateway, and Agent Gateway each authenticate at their boundary; authentication is not authority. Secrets are references only. Memory, microphone/camera/screen observations, security incidents, audit, prompts, and provider usage obey least exposure, redaction, consent, and provenance. Provider/network/node/sensor/audit degradation produces explicit degraded/unknown projections and preserves local baseline functions where possible. External integration failure is not Damar failure; Damar Core remains standalone. Legacy Console, Ollama, OpenClaw, and Hermes are not dependencies or restored systems.

## Current vs future

CURRENT_IMPLEMENTED: W1 canonical runtime/authority/capability truth, CLI/API and bounded channels, Sensorium lifecycle, Observation-to-Context, Mata Dewa runtime subsystem, internal Idle/Presence foundation.

CURRENT_PARTIAL: voice/provider/channel reachability and configuration-dependent provider paths; `llamacpp`; terminal WebSocket boundary; device/trust and realtime read-model gaps.

DESIGNED_NOT_IMPLEMENTED / FUTURE_WAVE: Idle visual shell, Dashboard, unified product projections, approval/notification stream contract, Model Registry, provider instances/key pools/quotas/role routing, Model Gateway, Agent Gateway, Remote Mesh experience, and final visual system.

## W2 non-goals

No production UI, Dashboard, Idle shell, terminal WebSocket, provider repair, model adapter, authority layer, capability registry, source-of-truth duplicate, retired runtime restoration, colors, typography, layout, animation, or 3D design.

## W1 delta ledger

REUSES_W1: identity/authority path, Manager, capability registry, verification/audit, RuntimeHost, Sensorium/Mata Dewa, channels, provider records, API/read/event/command catalogs.

EXTENDS_W1: surface responsibilities, read-model projection contract, continuity IDs/handoffs, approval/notification/interruption contracts, product-density modes, and device/awareness/security product projections.

NEW_PRODUCT_ABSTRACTION: logical model aliases, provider-instance/key/quota concepts, Model Gateway vs Agent Gateway separation, product-facing presence state projection.

FUTURE_IMPLEMENTATION / NO_RUNTIME_CHANGE: all unimplemented UI, gateway, multi-instance routing, remote mesh, and visual experiences. `PRODUCT_SOURCE_CHANGED=NO`.

## Handoffs

W3 implements hierarchy, state inventory, density, components, responsiveness, accessibility, and continuity/approval/notification/error states without choosing final aesthetic here. W4 defines routes, query/state layer, schemas, auth/session boundary, update streams, API client, shells, deep links. W5 implements Idle/Presence against the projection and approval contracts. W6 implements Dashboard against the IA and read models. W7 implements future provider/model/gateway contracts with Vault and routing constraints. W8 implements shared IDs, handoff, approvals, notifications, devices, and remote continuity across surfaces.
