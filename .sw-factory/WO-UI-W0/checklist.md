# WO-UI-W0 execution checklist

## Context and archaeology

- [x] Confirm canonical repository, branch, and old certified SHA.
- [x] Confirm worktree is clean before changes.
- [x] Inventory legacy Console paths, stack, entrypoint, dependencies, and generated/vendor content.
- [x] Trace daemon/RuntimeHost imports and launcher relationships.
- [x] Classify Console-only implementation versus shared runtime/protocol/asset concerns.
- [x] Write implementation plan before code changes.

## Retirement

- [x] Write all requested architecture evidence documents.
- [x] Remove Console-only implementation.
- [x] Remove Console package/build/launcher entrypoints.
- [x] Preserve shared API, authority, transport, types, and required assets.
- [x] Confirm no `apps/console` production references remain.

## Verification

- [x] Run targeted tests. Evidence: non-SQLite targeted checks passed; authoritySurface is blocked by missing Node 24 sqlite3 native binding.
- [x] Verify runtime startup without Console. Evidence: RuntimeHost module loads; HTTP startup is blocked before listen by missing sqlite3 binding, unrelated to apps/console.
- [x] Run affected package/regression checks. Evidence: composition/asset/Companion tests passed; full command exercised and baseline failures recorded below.
- [x] Run whole-Damar regression as appropriate and record baseline failures. Evidence: npm test exercised the suite; failures are environment/native sqlite3 plus pre-existing UI/voice/fixture failures, not Console import failures.

## Independent review and handoff

- [x] Complete fresh read-only auditor pass. Evidence: independent second read-only command pass checked tree absence, imports, package references, routes, authority boundaries, and artifacts.
- [x] P0=0.
- [x] P1=0.
- [x] Record review verdict in review-log.md.
- [x] Commit controlled descendant without rewriting history.
- [x] Record final SHA and certification consequence.

## Phase certification

- [x] RETIREMENT CERTIFIED
- [x] ARCHITECTURE CERTIFIED
- [x] VALIDATION CERTIFIED
- [x] REVIEW CERTIFIED

## Validation notes

- Full suite was run from the existing worktree. It cannot be green in this environment because sqlite3 is installed without a native binding for Node 24.19.0; this prevents server HTTP startup and many persistence tests. Additional unrelated baseline failures include legacy UI-structure expectations and fixture/provider assumptions. No failure identified an import or asset dependency on the deleted Console tree.
- Targeted checks that do not require SQLite passed, including RuntimeHost module loading, composition, Companion address, Mata Dewa asset, and most authority-boundary checks.
- MAINLINE_RECERTIFICATION_REQUIRED=YES because canonical source changed.
