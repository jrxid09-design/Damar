# R6 append-only checkpoint 01 (predecessor execution-r5-checkpoint-01.md)

Scope: R5 resume entrypoint `src/core-host/protected-admission.cjs:63-69` (lock identity check followed by pathname unlink). Claude session 2026-11-21.

## Fix (identity-bound, native, no pathname deletion of the lock)

- Lock is now opened with libuv Windows bits `UV_FS_O_EXLOCK` (0x10000000, CreateFile share mode 0) and `UV_FS_O_TEMPORARY` (0x40, FILE_FLAG_DELETE_ON_CLOSE + DELETE access) plus `O_CREAT|O_EXCL|O_RDWR`. While held, no process (including the holder) can open, rename or unlink it (EBUSY); a second create gets EEXIST. Closing the handle, or process death, deletes exactly the held object. The name-based `unlinkSync(lock)` is removed.
- Because the lock can no longer persist after crash/uncertain outcome, durable fail-closed retention moved to a write-ahead marker `admission.uncertain`, created (share mode 0, O_EXCL) and fsynced after lock acquisition and before any journal mutation. Clean outcome: identity-check the held marker, close it, unlink it while the exclusive lock still excludes every other engine. Uncertain outcome (`ADMISSION_OBJECT_*`, `ADMISSION_STATE_UNCERTAIN`, non-ADMISSION errors) or crash: marker stays; `status()` and every transaction refuse with `ADMISSION_LOCKED_OR_UNCERTAIN`. Host `ValidateDeployment` already refuses any storage child other than `admission.jsonl` (`AUTHORITY_STORAGE_RECONCILIATION_REQUIRED`), so the retained marker also blocks the service. Administrator reconciliation deletes the marker.
- Engine now denies non-Windows (`ADMISSION_PLATFORM_UNSUPPORTED`) because the flag bits are Windows-specific (0x40 is O_CREAT on Linux).
- Worker and C# host unchanged; `AdmissionSha256` pin must be updated at payload time.

## Evidence

- Safe isolated Temp probe (not product acceptance): held lock -> other-process rename/unlink/open EBUSY, `wx` EEXIST, same-process rename EBUSY, lstat identity readable; absent after close and after child exit without close.
- New test `held lock and marker cannot be renamed, replaced or unlinked; release deletes only the held objects`; crash-after-journal-fsync test now asserts lock absent + marker present + status locked; uncertain-write test asserts marker retained, lock absent, status and transaction refused.
- Focused `protected-admission`, `authority-worker`, `windows-authority-host`: 11/11 pass (`%TEMP%/r6-focused.tap`).
- Same tests run against the R5 engine backup: 3 fail (crash, uncertain retention, new race test), so the tests detect the old behavior.
- Hashes: engine `f6b383404c8aca043dc3376eb3faf5c4d534c50b092f7f9a15c131c32c558015`, test `53e688c4508d2cc2ce5b381a8b3a8693343e6517cf4128edc6665a54e96173f3`. Pre-edit backups in `r6-backup/` (engine `ff0cbd14...`, test `d4896a35...`).
- `graphify update .` run.
- Full safe serial suite (every `tests/*.test.cjs` except `computer-use.test.cjs`, `--test-concurrency=1`): **261/261 PASS** (R5 260 + 1 new), 0 fail/cancelled/skipped; `C:/Users/jrxid/AppData/Local/Temp/opencode/damar-r6-noninteractive-01.tap`. Interactive, service, inference, hardware tests NOT RUN.

## Startup marker (AuthorityService.cs OnStart)

- Probe proved `File.Exists` returns False for an existing marker when the service cannot list the directory / read the file (fail-open), while enumeration throws. Replaced with `RefuseStartupMarker(storage)`: `Directory.GetFileSystemEntries` for `authority-host.uncertain`, `admission.uncertain`, `admission.lock`; any hit or access failure refuses startup.
- `tests/windows-authority-host.test.cjs` extended: clean dir accepted, each marker refused, inaccessible marker (deny ACL; File.Exists reports hidden) refused. Full safe suite 261/261 (`damar-r6-noninteractive-02.tap`). Executable hash changes; rebuild at payload time.

## Live provider finding (Owner authorized live models 2026-11-21)

- 9router gateway `http://localhost:20127/v1` is up (52 models incl. `cx/gpt-6-luna`, vision=true). Own Core on 29640: `/api/r9/connect` with the active 9router key (read from local DB, never printed) -> 200 hasKey.
- `/api/r9/provider/model-grant` -> 503 `MODEL_GRANT_ROLLBACK_AUTHORITY_UNAVAILABLE`: `createModelGrants` requires a `witness` and `core-host.cjs` never passes one. No Core-side client for the authority pipe exists, the worker exposes admission `status/revoke/advance` (not the witness verify/advance shape), and the pipe allows mutations only for OwnerSid while Core must run as a distinct CoreSid (`ROLE_SEPARATION_REQUIRED`). Live inference is therefore structurally impossible in the current product until Core-identity separation + authority install + witness adapter exist. Zero paid completions were sent.

## Live path unblocked in Core (Owner chose user-level witness 2026-11-21)

- New `src/core-host/user-witness.cjs`: CAS anchor for the model-grant journal using the protected-admission engine, stored in `%LOCALAPPDATA%\DAMAR\authority\<scopeId>` (env `DAMAR_WITNESS_DIR`, passed to the Core child like `DAMAR_KEY_STORE`). Missing anchor vouches only for an empty journal. Same Windows account as Core: detects restore/rollback, not same-user malware; service witness remains the upgrade path.
- `provider-budget.cjs` `byteInputBound`: tokenizer-free authoritative input upper bound (UTF-8 bytes of messages/tools JSON + 16/message + 64); remote image URLs refused. Wired as `inputTokenBound` in `core-host.cjs`.
- Tests: `tests/user-witness.test.cjs` (restart, restored-journal rollback, deleted anchor, non-sequential CAS) + `model-grants.test.cjs` 13/13; `provider-budget.test.cjs` 9/9.
- Live probe (own Core 29640): connect 200, grant 200 effective, select ninerouter/cx-gpt-6-luna executable=true, one reservation sent; gateway answered 503 because 9router's upstream Codex OAuth token is expired (`token_expired`); meter blocked fail-closed, no tokens charged. Other gateway routes: auto:* / step-5 no credentials (404), dhl/* header timeout. Needs Owner to re-sign-in Codex in the 9router dashboard (http://localhost:20127).

## FIRST LIVE END-TO-END (2026-11-21, after Owner re-signed Codex in 9router)

- Gateway reports ~2495 hidden prompt tokens for a 1-message request (9router-injected system prompt). Added `GATEWAY_INJECTED_TOKENS = 4096` allowance to `byteInputBound` (ponytail comment; exceeding it still blocks fail-closed).
- Probe `claude-live-20261121125737` (own Core 29640, witness in scratch): connect 200 -> grant 200 effective -> select executable -> Pandawa puntadewa run COMPLETED, output "2+3 = 5."; durable receipt ninerouter/cx/gpt-6-luna input 3182, output 11, confirmedReceipts 1, canonical usageService agrees (3182/11). Cost still `UNAVAILABLE_NO_RATE_PROVENANCE`.
- Full safe suite (excluding computer-use and in-progress control-/presence- tests): 265/265 (`damar-r6-noninteractive-03.tap`, run before the allowance constant; budget+witness tests 13/13 after it).

## Live agent turn (CLI main flow) end-to-end

- `provider-deadlines.cjs` `loopbackStream` refused the approved gateway URL `http://localhost:20127/v1` (`PROVIDER_LOOPBACK_REQUIRED`): now pins `localhost` to `127.0.0.1` (no name resolution); everything else still refused. Gateway listens on 0.0.0.0:20127, reachable on 127.0.0.1.
- Probe `claude-liveturn-*` (own Core 29640): natural-language turn "fix calc.py and run the tests" -> GLOB, READ x2, permission (session) -> EDIT calc.py diff, permission -> VERIFY `python -m unittest -v` -> final COMPLETED "add now returns a + b ... all 1 test passed"; file verified fixed. 10 confirmed receipts, 68281 in / 401 out, zero unknown usage.
- Control dashboard delivered by sub-agent (see execution-r6-control-01.md): full safe suite 273/273.

## Owner directive: remove artificial limits (2026-11-21)

Owner: earlier ChatGPT-led work restricted DAMAR; remove what blocks capability/performance, keep real protections.
- `model-grants.cjs`: grants accept ninerouter (gateway) or custom-loopback (loopback URL); model any id or `*`; expiry up to 366 days (was 24 h); limits optional (unset -> Core session caps). `provider-registry.cjs` `authorizedModels` now from the actual grant.
- `provider-budget.cjs` session runaway caps: output 32768 (was 512), completions 10000 (was 100), total 50M tokens (was 100k).
- `core-host.cjs`: loopback-only egress guard now opt-in (`DAMAR_EGRESS=loopback`); default Core may reach the network.
- New `workspace_shell` tool (`workspace-tools.cjs` `runShell`): any PowerShell command in the workspace with the user's real PATH/profile and network, Owner permission card per command (auto only under `full-access`, not `workspace-auto`), DAMAR_*/TOKEN/SECRET/API_KEY env stripped, timeout (default 600 s, max 1800 s), 64 KB output cap, process tree killed on timeout/cancel. Live: `git --version; node --version` through card -> COMPLETED. Test `tests/workspace-shell.test.cjs`.
- Vision: gateway metadata `capabilities.vision === true` marks the selected model's image input `verified` (enables the transient image bridge).
- Kept: auth/roles, permission cards, secret redaction, usage receipts, witness/rollback detection, fail-closed meter.
- Full suite at that point 291/292; the single failure is the CLI agent's in-progress hint-text change in `subagents.test.cjs` (owned by that agent).

## Residual

- Marker unlink is still by name after close; safe against concurrent engines (lock held), not against a non-engine actor with write access to the protected storage directory (that actor can already alter the journal). A native SetFileInformationByHandle(FileDispositionInfo) path would close it fully; not available from Node without an addon.
- Remaining R5 queue unchanged: trusted bootstrap/source integrity (`AuthorityService.cs:39-87`), storage children and marker cold-start/crash interleavings, child ACL/substitution coverage, then immutable payload; privileged SCM/identity, provider contract and interactive acceptance still external. NOT SOFTWARE_INSTALL_READY, NOT PRODUCTION_VERIFIED.
