# Settings provider Save/Apply

Scope: preserve the fixed NineRouter gateway boundary, omit equivalent endpoint writes, prevalidate model authorization before credential persistence, refresh authoritative state, keep revocation explicit. No live inference, active Core restart, port 29623 changes, release or integration.

1. Reproduce payload with recording Core and loopback metadata fixtures. Compare localhost and 127.0.0.1 only for the fixed gateway, keeping scheme, port and path exact.
2. Patch existing Settings submission and existing Core connect validation, not routing architecture. Validate selected model in the connect request before mutations. Keep the frozen approved live model unchanged.
3. Verify rejection leaves credentials/routes unchanged, DPAPI survives scratch restart, and authoritative UI masks reflect readback.
4. Run affected and full tests, update graph, record limitations.

UI refinement: keep the existing SettingsCenter and renderer. Display one focused section, compact section navigation and persistent Save/Apply/Cancel actions. Keep reasons as F1 contextual help; errors remain visible. Preserve DAMAR palette and Indonesian/English labels. No font-size simulation. ENERGY 1 / RHYTHM 1 / MOTION 1 for this functional form.

Transaction consistency continuation: existing runtime activation writes multiple stores and reconfigures runtime; no cross-store transaction primitive exists. Do not claim rollback. Serialize provider mutations using the existing Core queue. Journal only phase/provider/model in a private CLI receipt, never credentials or request bodies. Mark uncertain submissions, read back authoritative state without replay, and retain unresolved receipts across CLI restart. Report connection-known/selection-unknown explicitly. Test failure before and after each boundary and concurrent Core operations.

## R4 protected-authority continuation (R3 checkpoint is predecessor)

1. Harden the existing host marker using the created handle: verify final name, single-link non-reparse identity, parent pinned identity, and owner/DACL before writing. Keep the handle across the worker and delete by handle only after a known result; uncertain results remain durable. Exercise hostile replacement and crash persistence in isolated fixtures.
2. Close admission.lock cleanup's check/unlink window with a Windows handle-bound deletion mechanism, or retain uncertain state rather than delete when reliable cleanup cannot be demonstrated. Test concurrent and crash behavior without weakening the fail-closed policy.
3. Extend bootstrap and storage-child adversarial tests, then run affected/full safe regression. Only after these gates inventory and hash minimal payload, prepare reviewed offline installation handoff; do not install or touch active Core.
4. Independently finish read-only Control schema and restricted-identity contracts, and record provider/interactive gates as pending when external evidence is absent. Keep an append-only R4 checkpoint and update graph after code changes.
