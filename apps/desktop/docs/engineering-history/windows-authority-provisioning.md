# Windows protected authority: provisioning decision, not an installer

## Isolated implementation

src/core-host/protected-admission.cjs is the storage/admission engine for a future separately administered authority. It is NOT connected to Core, NOT a production witness, and NOT a service executable. Administrator bootstrap creates a new scope exactly once; missing state never auto-provisions. Durable state includes sequence, grant revision/revocation/expiry, conservative attempts/token/cost reservations and one pending request. Duplicate IDs, stale revisions, clock reversal, uncertain receipt, torn journal and retained crash lock fail closed. No refunds are applied after settlement. Engine assumes trusted bounds and receipts supplied by the authority host, never a Core caller. Existing provider key storage remains untouched.

## Threat model

Dedicated service identity/storage can resist an ordinary Core user restoring Core files. It cannot resist local administrator, service-account compromise, or whole-machine/storage rollback. Those require a genuinely external authority or demonstrated hardware monotonic anchoring. This engine does not claim resistance to restoring its OWN valid journal: protected storage is a provisioning boundary, not a cryptographic freshness trick.

## Exact provisioning prerequisites and procedure

Do not execute this procedure without separate Owner/admin approval:

1. Approve the threat model and a named dedicated service account/virtual service identity. Confirm the ordinary Core account is not allowed to administer the service, replace its executable/configuration or read/write its storage. If the Core account has usable administrator elevation, document that elevation is outside the claimed threat boundary.
2. Supply a reviewed Windows ServiceBase/native ServiceMain host (available local .NET tooling is not a deployed host). Node core-host.cjs is not an SCM service. Host must implement bounded named-pipe messages, Windows client identity authentication and explicit pipe ACLs. Separate administrator enrollment/revoke/receipt authority from ordinary Core requests. No loopback shared bearer token file or generic advance/settle endpoint available to Core.
3. Choose administrator-owned binary path and ProgramData storage path. Disable inherited write permissions; grant only SYSTEM, designated administrators and the service identity access. Pin the service host, runtime, engine, configuration and protocol hashes. Review ACLs from the actual Core token, including parent paths and service-control permissions. No ACL changes have been performed.
4. Administrator provisions exact candidate/session/port/provider/endpoint/model digest, limits, currency/prices and expiry from explicit Owner approval. No automatic re-enrollment. Production host must not expose provisionAdmission to Core.
5. Authority must own one-use admission and dispatch, or enforce admission at the gateway. Bind request digest and every billed upstream attempt to a durable reservation. Core must not be able to bypass it. Existing provider credential belongs to Core; credential transfer or gateway credential/admission changes require separate approval. There is no silently compatible solution to this ownership boundary.
6. Verify provider contract first: enforceable input/output/spend bounds, exact usage categories, no internal retries/fallback. Host accepts only authoritative receipts; Core-provided settlement is not trustworthy. Until this is established keep transport disabled.
7. Test service process termination before/after journal fsync and before/after provider send, simultaneous clients, stale/replayed requests, clock rollback, missing/corrupt storage, restored Core journals, and unauthorized identity access. Verify crash lock recovery only through administrator reconciliation. Do not automatically delete stale locks or replay pending dispatch.
8. Missing/stale protected authority database: keep disabled, reconcile against independent authoritative evidence, then explicitly re-enroll a new scope if approved. Never restore a backup and assert freshness without an independent anchor. Service restart cannot reset spent attempts, budgets, revocation or expiry.
9. Only after these tests and provider/Owner gates pass: present one Core 29785 supervised-restart preflight. Recheck outstanding work and preserve exact session/store paths. No provisioning permission is inferred from a model approval.

## Provider investigation delta

Installed 9router-pro chunks 3225.js/5330.js contain max_input_tokens for other model-config/context-tier code, including auto-selection using estimatedTokens. This does not establish an enforced cap for cx/gpt-6-luna. No max_prompt_tokens occurrence found in the inspected server chunks. max_output_tokens/max_completion_tokens occur in translation paths, but occurrences alone do not prove upstream enforcement, reasoning inclusion, retry policy or monetary admission for this exact configured route. No provider runtime/config/credential database inspected and no inference/count-token endpoint invoked.

Concrete external dependency: gateway/provider maintainer must supply a version-bound contract for exact cx route describing input cap/tokenizer, output/reasoning enforcement, aggregate usage categories, actual price/currency and retry/fallback controls. Alternatively provision a separately approved metering/dispatch gateway with those guarantees. Do not implement an estimator or change the approved accounting semantics to make the test pass.

## Verification checkpoint

Five isolated engine tests cover independent protected-state revocation versus restored Core journal, scope mismatch, pending reservation across reopen, no replay/refund, exhausted budgets, missing/torn/locked state, clock reversal, competing process, and child-process exit after fsync with durable pending state and retained lock. These run without privilege and do not prove installed ACL/service behavior.

First fresh full run: 255/256, one existing native Computer-Use failure VERIFICATION_FAILED versus EXECUTED_VERIFIED. No claim of a clean 256/256 run at that point. Logs retained at C:/Users/jrxid/AppData/Local/Temp/opencode/damar-production-full.tap. The failure is not a reason to relax foreground/verification checks. No protected Core was restarted.

Completion classification: B, specific external provider-contract and privileged-identity provisioning dependencies. Service transport integration cannot safely be activated while credential ownership and provider contract are unresolved. This is a bounded implementation/provisioning decision, not production readiness or another speculative manager.

Fresh complete rerun: 256/256 passed, damar-production-full-rerun.tap. Prior native failure remains relevant flakiness evidence, not erased by the rerun. Exact inventory: 4856 source/test/bundled runtime/dependency/root launcher/JSON files, excluding __pycache__; SHA256 3c2b0dd9c85b18d70d5d23fe332cee2444d7dff1938c9d2de9976778f7da9c50, manifest damar-production-build.json in the same temp directory. Windows OS and external Python runtime are not covered. Protected listener readback remains 29785 PID 10480, 29623 PID 3192.
