# Wave8 L3/L5 synchronous audit callback clarification

**Owner authorization:** 2026-09-18

This is a narrow clarification for the injected audit callbacks in W8-L3
(spatial) and W8-L5 (simulation). It does not reopen other Wave8 contracts.

- The callback is invoked synchronously. Its return value is not
  acknowledgement, authority, or canonical state.
- Promise and thenable return objects are unsupported and discarded without
  inspection, mutation, normalization, awaiting, assimilation, or handler
  attachment.
- Synchronous callback exceptions retain each lane's existing best-effort
  behavior. Neither a callback return object nor its state can alter lane
  state or grant authority.
- Any operation that separately requires an audit acknowledgement must fail
  closed when it has no supported synchronous acknowledgement.
- Future asynchronous delivery requires a separate trusted port/adapter with
  owned lifecycle, queueing, persistence, error containment, and verification.

The frozen-contract clarification is recorded beside the L3 and L5 audit-hook
clauses in `C:\Workspace\Damar-audit-evidence\wave7-10\wave8-recon\WAVE8_CONTRACTS_FROZEN.md`.
