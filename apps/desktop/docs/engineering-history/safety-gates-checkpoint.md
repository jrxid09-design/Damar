# Safety gates: blocked preflight, not restart approval

## Verified candidate

Fresh complete suite: 248/248 passed. TAP: C:/Users/jrxid/AppData/Local/Temp/opencode/damar-safety-full.tap.
Real scratch Core: D:/Damar/R9_WORK/r7r3-scratch/model-grants-1794994571348, port 29993, official stop/resume; missing independent witness rejected before and after resume; requester denied; zero provider requests. Evidence: damar-safety-core.log in the same temp directory.
Build inventory: 4854 files under src, tests, inherited-v53, core-snapshot, python-vendor, and root PowerShell/JSON files (excluding __pycache__). SHA-256 cffbe8e9ad26466fd000115f9cd1d8ae5844216079707dfa26dd10ad75ff5f51. Manifest: damar-safety-build.json. External Windows/Python runtime and OS integrity are not covered by this digest.

## Anti-rollback

Grant journal now requires a separate compare-and-advance witness. Advance precedes journal write; mismatches and uncertain state fail closed. Offline witness contract tests reject old valid journal restoration, full truncation, corruption, concurrent mutation and cross-scope reuse. Test witness is memory-only and NOT production authority.

No production witness was invented. Inspected canonical src/authority and snapshot ownerTrustComposition.js: existing initialization anchor, vault and audit ledger are local mutable files, not independently protected monotonic storage. DPAPI protects confidentiality/integrity, not freshness of a previously valid ciphertext. Read-only Get-Tpm returned null capability fields, not evidence of usable TPM monotonic support. Production composition deliberately supplies no witness, so native model grants return 503 MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE. A prior nonempty journal without witness fails closed. This supersedes the earlier restart-persistence acceptance: that acceptance lacked rollback protection.

External requirement: provision an independently administered monotonic/CAS authority (including nondecreasing time), or an approved platform-backed counter service. A second file or same-user registry value cannot honestly satisfy the stated local rollback threat. Recovery must never auto-enroll/reset a missing witness. Recovery integration against a real protected witness remains unverified.

## Durable budget reservations

RESERVED record fsyncs before HTTP dispatch. SETTLED references reservation; pending/unknown/partial usage blocks subsequent dispatch, including after restart. Attempts count reservations, not just successful responses. Serialized post/stream paths prevent overlapping reservations. Cancellation remains unmetered/fail-closed. No automatic replay added.

For scoped grants a Core-injected authoritative input-token upper bound is mandatory. Caller-provided inputTokenUpperBound is ignored. Aggregate admission checks input upper bound plus maximum output against remaining total. Production has no such tokenizer/provider contract, so scoped dispatch is blocked with PROVIDER_INPUT_TOKEN_BOUND_REQUIRED even if a witness were supplied. Output-only historical behavior remains for the unchanged legacy constant. Tests cover unresolved reservations, partial receipts, restart, concurrency, and pre-network journal visibility. Actual process-crash fault injection at each fsync boundary is not yet covered. Budget ledger is not itself rollback-resistant; protected-witness integration is still needed for the same local rollback threat.

## Historical limits

Current Owner message reports 100 completions including retries, 512 tokens/request, 100000 aggregate tokens, no automatic retries, one Owner-designated window/session. This is reported history, not applied grant proof. Searches of candidate/canonical Markdown and existing authorization notes did not recover original approval with exact semantics. Code defaults match numbers but cannot establish provenance.

Unresolved: whether 512 is output tokens or all request tokens; inclusion of input, reasoning, cache and tool tokens in aggregate; monetary ceiling/currency and authoritative pricing; effective expiry; original approval artifact; exact window title/PID/fingerprint and permitted interactions. Existing readUsage understands prompt/input and completion/output counters only. Do not infer semantics or dispatch paid requests.

## Active Core and restart decision

Read-only 29785: READY, zero outstanding turns/permissions/Pandawa/jobs; version db4116e4-daec-47dd-b8e5-98b90feb19ac:1, ninerouter http://localhost:20127/v1, hasKey/keyRemembered true, model null, executable false. Listener PID 10480; legacy 29623 PID 3192. Neither restarted or mutated; existing provider credential untouched.

Restart NOT recommended. Conditional impact remains temporary disconnect, incarnation/configuration token rotation, preserved exact directory/port/store paths, explicit model reselect after grant readback. No recovery/new-session substitution. Native Settings authorization state and physical Owner window selection remain unverified in this checkpoint; regression tests are not physical/native acceptance. No new Computer-Use lease or window authorization applied. No paid inference, Pandawa or Computer-Use acceptance. No canonical integration, commit/push, deployment or release.
