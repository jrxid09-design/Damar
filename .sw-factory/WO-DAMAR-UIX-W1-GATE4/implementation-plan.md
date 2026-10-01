# DAMAR UIX-W1 Authority Convergence Repair Gate 4

## Summary

Repair the confirmed autonomous NAS/usage/backup notification bypass by routing notification delivery through Damar's existing canonical capability path. `notifyService` will remain a composition/routing adapter and will submit a `messaging.whatsapp.broadcast` request; it will not call or authorize the WhatsApp transport. The existing Lane 2 authority evaluation, Lane 3 actuator, Lane 4 verifier, and durable audit acknowledgement remain the only governance path. Autonomous callers continue without interactive prompts when a valid canonical standing grant and authenticated session permit the notification; otherwise no external send occurs.

## Code Reuse And Package Structure

Reuse:

- `src/services/governedServiceBoundary.js` and `src/services/canonicalActionClient.js` for canonical Manager submission and fail-closed missing context.
- `src/action/capabilities/embodimentWiring.js` for declarative capability registration, actuator registration, availability observation, and verifier wiring.
- `src/services/embodimentDrivers.js` for the Lane 3 host-I/O driver/observation pattern.
- `src/core/verify/verifiers.js` message-ID semantics as the transport evidence model.
- Existing canonical Lane 2/Lane 3/Lane 4 composition and `canonicalAuditAcknowledger` without new authority classes or guards.

Planned changes:

- `src/services/notifyService.js`: remove direct WhatsApp import/call; submit governed broadcast requests and preserve notification result shape.
- `src/services/whatsappService.js`: retain transport responsibility and expose transport evidence needed by the governed actuator without granting authority.
- `src/services/embodimentDrivers.js`: add the WhatsApp notification actuator and verifier evidence functions.
- `src/action/capabilities/embodimentWiring.js`: declare and wire `messaging.whatsapp.broadcast` through the existing canonical registries.
- `tests/authority/autonomousNotificationConvergence.test.js`: source and behavior tests for NAS, usage, backup, notify role, WhatsApp role, missing authority, standing authority, verification, audit ordering, and regression guards.
- `C:\Workspace\Damar-audit-evidence\web-dashboard\DAMAR_UIX_W1_AUTHORITY_CONVERGENCE_REPAIR_4.md`: final evidence record.

## Components And Flow

The governed flow is:

`NAS/usage/backup event -> notifyService.send -> submitGovernedService -> canonical Manager -> ActionIntent -> Authority Gate -> canonical Lane 3 messaging actuator -> whatsappService transport -> message IDs -> Lane 4 verifier -> durable audit acknowledgement`.

The notification capability is descriptive registration only. Authority remains the existing Owner-ratified grant evaluated by Lane 2 against the authenticated principal/session and bounded scope/generation/expiry semantics. A standing grant permits autonomous execution without a click; it is not minted by `notifyService`, the actuator, WhatsApp connectivity, or an event detector.

The actuator reports transport acceptance only as supported by the existing WhatsApp contract: each attempted send must return a message ID and no send error. The verifier reports `verified` only when message-ID evidence exists for every requested recipient; no delivery-to-user claim is added. Missing IDs, transport errors, unavailable verifier, or missing audit acknowledgement remain non-success outcomes.

## Steps

1. Add the governed WhatsApp broadcast capability to the existing embodiment wiring and transport driver/verifier.
2. Replace `notifyService`'s direct broadcast with the canonical governed submission, preserving caller formatting and fail-closed behavior.
3. Add focused source-backed tests for all confirmed autonomous callers and both denial and standing-authority success behavior.
4. Run targeted suites three consecutive times, then run the required regression suites and attempt `npm test` after dependency preparation.
5. Perform a fresh source sweep, write the repair evidence with exact statuses and blockers, review the diff, and create a traceable repair commit without touching unrelated worktree changes.

## Testing

- New notification convergence tests: direct `notifyService`/`whatsappService` negative paths, NAS/usage/backup source guards, canonical capability admission, transport evidence verification, and audit ordering.
- Existing canonical capability bridge tests for authority, verification, and audit acknowledgement.
- Existing Repair 13 regressions: PlanExecutor, ToolRegistry, HTTP mutation, unknown/neutral plugins, and DCD authority suites.
- Existing Manager/ActionIntent/Authority/Actuation/Verification/Audit targeted suites.
- Three consecutive clean targeted runs are required.
- Attempt `npm test` after normal dependency preparation; preserve the known continuity-store defect and verification-storm stall as separate blockers if reproduced.
