# W8-IW1 embodiment identity fabric

## Scope

Migrate the durable embodiment identity snapshot mutation path behind the
canonical Manager-owned capability execution boundary. Reads remain inert and
are not authority-gated. The capability is declarative, operation-level, and
deny-until-ratified.

## Design

- `embodiment.identity.snapshot.write` owns the `save` operation.
- `src/embodiment/identity/fileStore.js` retains the IdentityStore port and
  validation, but delegates all filesystem mutation to the internal capability
  runtime.
- The Manager-owned capability module owns the private driver table and uses
  the canonical capability bridge for authority, exact binding, verification,
  durable audit acknowledgement, and replay consumption.
- No owner grant is minted by production composition. Test fixtures use an
  explicit ACTIVE grant-shaped authority store only for authorized-path tests.

## Verification

- Existing identity persistence and corruption suites.
- New unratified, ratified, wrong binding, expiry, revocation, replay, audit
  failure, and cancellation tests.
- Wave8 census and cluster oracle; expected structural reduction is four sink
  sites and no added governed bypass.
