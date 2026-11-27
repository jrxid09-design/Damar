# Coucou Island logic provenance

- Upstream: `https://github.com/Louis-CFM/coucou.git`
- Reviewed and pinned revision: `b1bc09de7f7c24a80bd8eca5729b8bee60f66402`
- Isolated inspection clone: `C:\Users\jrxid\AppData\Local\Temp\opencode\coucou-b1bc09de7f7c24a80bd8eca5729b8bee60f66402`
- Adapted code: generic state/timer behavior from `windows/src/island/fsm.ts`, limited to hidden/compact/expanded states, pointer entry/exit, reveal, auto-collapse, and configurable inactivity.
- Technical references only: `windows/src/island/island.ts` and `windows/src-tauri/src/island.rs` for overlay geometry, monitor/DPI, click-through, pointer wake and focus boundaries.
- Host: DAMAR's existing Electron desktop window and preload IPC, served by the unified loopback endpoint on port 2906. No Tauri sidecar or second runtime authority.
- Excluded: Coucou/Mochi brand, character, artwork, sounds, icons, hooks, agents, credentials, approvals, providers and unrelated integrations.
- License: MIT. The full upstream license is retained in `LICENSE`; the adaptation file header retains the upstream copyright notice.
