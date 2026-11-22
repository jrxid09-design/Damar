# R3 append-only checkpoint 01

Linked predecessor execution-r2-checkpoint-01.md and execution-r2-ledger.json. Current verdict NOT INSTALL_READY; runnable engineering remains. Session stopping at execution boundary, not task completion or all-external dependency claim.

## Changes / actual verification

Host uncertainty marker now created with native CREATE_NEW/open-reparse/write-through, retained exclusive write/delete handle from before worker start through uncertainty/completion; latching writes same stream and flushes; successful completion deletes by SetFileInformationByHandle instead of reopening/deleting name. Direct reflection test on actual compiled methods denies outsider write/rename/delete, verifies fixed uncertainty bytes and handle deletion. Initial test read failed sharing because reader did not share DELETE, corrected test reader to share original access; no product acceptance weakening. Native marker ownership/ACL, final-path verification and crash-child test remain to implement. Process launch failures retain marker; startup rejects retained marker. No automatic reconciliation.

Storage deployment checks enumerate all children and reject any except pinned admission.jsonl with AUTHORITY_STORAGE_RECONCILIATION_REQUIRED; pinned journal private ACL checked explicitly. Node engine transient lock cleanup still name-based; not race-free. No claims complete A1/A2/A3.

Affected host/admission/worker 10/10. Fresh selected noninteractive suite 260/260, zero skipped; only computer-use.test.cjs deliberately excluded. C:/Users/jrxid/AppData/Local/Temp/opencode/damar-r3-noninteractive-01.tap. Full R3 suite NOT RUN. Old 257/258 does not certify R3. Owner desktop not focused or injected into.

Build DamarProtectedAuthority-r3-01.exe SHA256 d13ce7bd0af6d26abc6d5e0ed7f6fdae370c03986857398597d24852b5d0207f, approved opencode temp. Component record damar-r3-components-01.json. Intermediate only, no installer/payload approval. Node 3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237; worker 8527abca18fb3be0dc339eb05219c480049049f11af70d925c98967dd7ce2545; admission ff0cbd1438d6992e988468b54d23c3a4a95c5ba4566304fd15ab44b2c84934be.

## Independent work

Read only known installed npm package.json, no data/config/credential paths: 9router-pro 0.5.109-pro.15, C:/Users/jrxid/AppData/Roaming/npm/node_modules/9router-pro/package.json SHA256 019aff0439157978583abbae7db2af4f790f1c097094adb6fbe7cc9e27cd8b3a. Establishes installed package metadata, not actual running gateway code identity or exact-route enforcement. Existing missing input/output/reasoning/retry/usage/monetary/credential-dispatch contract remains. No inference or gateway request made.

Control route/schema extraction from r9-routes.cjs:164-334 added control-api-schema-r3.json, maps provider/model-grants, credential ingress only, lifecycle, sessions, usage, settings, sandbox, Pandawa, turns/SSE/permission/cancel, recovery/checkpoints/memory. Existing authority reuse; no Control implementation. Session exact variants/startRun/console/MCP need focused extraction still. No API invoked on active Core.

## Queue / next runnable

A1: finish native marker security descriptor/final identity and crash persistence tests; transient admission.lock native identity-bound cleanup remains (Node does not supply Windows O_NOFOLLOW/delete-by-handle). A2 trusted bootstrap positive tests under actual virtual identity pending; offline schema/ACL policy tests runnable. A3 actual child ACL positive/negative tests runnable. Restricted identity actual acquisition requires proper privileged harness; prepared probe remains unexecuted. Shared-desktop Computer-Use pending exclusive/isolated desktop; do not rerun while Owner possibly active. B payload/install helper depends software gates; no privileged stage. E/F offline tested, live acceptance pending provider/authority/Owner authorization. G remaining request schemas runnable. Do not request action while software runnable tasks remain.

Resume same candidate, read source/checkpoint, continue next A1 native marker validation or independent schema task, use new evidence suffix r3-02+, preserve prior logs/builds. No background execution remains after stop. No privileged operations, global ACLs/ownership, credentials, active Core 29785/29623, paid inference, canonical integration, Git stage/commit/push, release or Human-Twin work.
