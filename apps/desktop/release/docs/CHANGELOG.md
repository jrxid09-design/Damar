# Changelog

## 1.0.0 (first public release)

### Added
- **Windows installer** (per-user, no administrator rights) and portable zip. The installer adds Start menu shortcuts for DAMAR CLI, DAMAR Control and DAMAR Presence, an optional sign-in entry for Presence, and the `damar` command on PATH. It upgrades in place and its uninstaller keeps your data unless you ask to remove it.
- **Bundled runtimes:** Node.js 24.19.0, Python 3.12.10 and Electron 30.5.1. No system Python or Node.js is needed.
- **`damar` launcher:** `damar core start|stop|status`, `damar control`, `damar presence` and `damar shutdown`. Core starts in the background on demand, resumes after a clean stop and recovers after a crash.
- **DAMAR CLI:** a full-screen terminal agent with permission cards, diff preview, undo/redo checkpoints, project memory, saved and resumable sessions, parallel Pandawa sub-agents, a command palette, and English and Indonesian interfaces.
- **DAMAR Control:** a loopback dashboard for overview, sessions, usage, providers and model grants, models, capabilities, Pandawa runs, security, settings, diagnostics and Mata Dewa.
- **DAMAR Presence:** an Idle Presence and Notch desktop surface that reads Core state.
- **Mata Dewa:** opt-in public world feeds, with consent and per-source attribution.
- **Provider model:** connect any OpenAI-compatible provider. Live calls require an expiring model grant. Keys are write-only and can be remembered with DPAPI.
- **Update check:** `damar update check` verifies an Ed25519-signed release manifest. It is disabled unless an update URL is configured, and it never installs anything by itself.
- **Session retention:** only the newest Core session folders are kept (`DAMAR_KEEP_SESSIONS`, default 5).
- **Release integrity:** a SHA-256 manifest of every shipped file, a CycloneDX SBOM and third-party license notices.
