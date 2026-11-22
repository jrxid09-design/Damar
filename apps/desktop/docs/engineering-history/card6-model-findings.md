# Card 6 and model mismatch evidence

Read-only Core 29785 observation (2026-11-18): configuration version db4116e4-daec-47dd-b8e5-98b90feb19ac:1; NineRouter hasKey=true, keyRemembered=true, model=null, executable=false. Credential is persisted independently of model selection. No key extracted, replaced or replayed.

Authenticated Core metadata route returned cx/gpt-6-luna, not 9router/cx/gpt-6-luna. fetchModels preserves gateway ids verbatim. Settings and applyProvider require the exact approved id; registry connect/select also require it. Runtime dispatch guard compares that same exact id. No alias contract exists in the candidate. The catalog entry is real, not a selected authoritative model. No mutation was submitted to the active Core.

External blocker: need authoritative gateway alias mapping for these exact ids, or explicit bounded authorization for the gateway-native cx/gpt-6-luna id. Neither is inferred here. Existing rejection preserved. No additional credential entry needed.

Card 6 now renders test, doctor, save, apply, cancel in its original card; no external duplicate action footer. Cards 1-5 unchanged. F1 explanation footer remains, without actions.

Verification: affected tests 47/47; full fresh suite 236/236. TAP: C:/Users/jrxid/AppData/Local/Temp/opencode/damar-card6-full.tap.
Native screenshots, screen buffers and result.json:
- D:/Damar/R9_WORK/r7r3-scratch/damar-card6-wt-20261118-155602 (80x30)
- D:/Damar/R9_WORK/r7r3-scratch/damar-card6-conhost-20261118-155637 (120x30)
Both probes pass; injected console records, not physical HID. Card 6 appearance and cancel click verified in real host; Save/Apply routing tested by regression harness, not claimed as real-provider acceptance. Scratch Core stopped gracefully. Active 29623/29785 not restarted or overwritten.
