# CLI development baseline status

Provider UI enhancements frozen by Owner directive. Control implementation not started.

Source/test/launcher manifest SHA-256: d29bd64514e8b56c2a0862b9b564c68d75b8240b93c7968b4b304b56d5e49f30
Scope: 183 source/test/launcher files, not a packaged product or inherited dependency hash.
Manifest and fresh full-suite TAP retained in C:/Users/jrxid/AppData/Local/Temp/opencode/:
- damar-baseline-build-manifest.json
- damar-baseline-full.tap (235/235 pass)
- damar-txn-core-final.jsonl (real scratch Core, port 29783, metadata only, DPAPI persistence and stale version refusal)
- damar-txn-dpapi-final.jsonl

Native injected-input evidence:
- D:/Damar/R9_WORK/r7r3-scratch/damar-txn-wt-narrow-20261118-152241/result.json (80x30)
- D:/Damar/R9_WORK/r7r3-scratch/damar-txn-native80-20261118-152445/result.json (80x30)
Both passed; synthetic console records, not physical Owner input. Subsequent source change affects outcome reporting, not layout.

Core contracts remain authoritative. Provider writes serialized via existing queue. Optimistic version tokens span Connect and Select; old epoch tokens fail after restart. CLI receipts contain only provider, model, phase, time; uncertain operations reconcile by GET without credential replay. This is NOT atomic cross-store commit or rollback. A crash may leave routing/DPAPI/runtime partially applied. Reconciliation displays authoritative current state, cannot prove which credential was committed, and requires review before another Apply. Active model persistence across restart is not established by key persistence tests.

Live baseline NOT demonstrated. Read-only Core 29625 report: ninerouter key present/remembered, model null, executable false, liveInferenceAuthorized false. No candidate key-store content read or copied. No live request issued. Approved model remains 9router/cx/gpt-6-luna. Existing key provenance was explicitly restricted earlier; secure Owner entry into the intended build is required before using it. No credential requested in chat.

Additional offline ConPTY agent journey attempt failed with AttachConsole failed; no journey success claimed. Full test suite includes safety, lifecycle, leases, recovery, Computer-Use and tool tests but does not substitute for live provider acceptance.

Control handover gate: blocked until actual Core-owned live inference, tools/Pandawa/Computer-Use receipts and independently verified results have been reported and reviewed. Future Control must reuse existing Core contracts, not create parallel authority.
