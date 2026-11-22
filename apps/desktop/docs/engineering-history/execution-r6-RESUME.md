# R6 resume point (2026-11-21, usage limit hit; resets 20:20 Asia/Jakarta)

All parallel agents stopped mid-round on the 5-hour usage limit. Their work so far is saved in R. Resume each round from its brief:

| Workstream | Last state | Resume with |
|---|---|---|
| Control/CLI (execution-r6-control-02.md done) | Round 3 in progress: voiceEnabled toggle, English default, live sync, onboarding, a11y, probe updates. Caused 10 in-progress suite failures (control-dashboard 128/163, presence-core 82, ui-settings 14, visual-design 37/66/97/115, w5-renderer-lifecycle 77/207). Provider code is now owned by the provider agent. | Finish round 3, fix those failures, write execution-r6-control-03.md |
| Presence/Notch (execution-r6-presence-01.md done) | Round 2 in progress: "Damar Notch" rename (no Mochi), Allow/Deny in notch (surface:'notch'), voiceEnabled opt-in (added core-settings.cjs:20,29), GET /api/r9/activity, clipping/reduced-motion/local Cinzel, English-first | Finish round 2, write execution-r6-presence-02.md |
| Mata Dewa (execution-r6-matadewa-01.md done, 6 live feeds) | Round 2 just started: egress guard allowlist, user keys (OpenSky/AIS/FIRMS/TomTom), persisted cache, cyclones, helpers.controlSession, i18n, licensing UI (Open-Meteo non-commercial) | Do round 2, write execution-r6-matadewa-02.md |
| Mata Dewa round 3 (Owner 2026-11-21) | Not started | Military aircraft from public ADS-B with full identifiers (still withhold LADD/PIA opt-out aircraft); CCTV grid: official public cameras + Owner-registered own RTSP/ONVIF cameras; ALPR only on Owner-registered own cameras: local processing, vehicle log, watchlist + alerts to notch/Control, retention setting. Refuse: unsecured third-party cams, ALPR on public cams, plate-to-identity lookup. |
| Provider-agnostic refactor | Started: remove ninerouter/fixed gateway/APPROVED_LIVE_MODEL, user-defined OpenAI-compatible connections + presets, migration of Owner's 9router to "My router" connection | Complete per brief, write execution-r6-providers-01.md |
| Release engineering | Started: installer, signing pipeline (no cert yet), SBOM/licenses, public English docs, clean-machine smoke; was adding a backward-compatible data-root override in Core | Complete per brief, write execution-r6-release-01.md |

2026-11-22 Owner-delegated actions by lead: legacy provider migration run on `r7r3-scratch\owner-provider-keys` (MIGRATED, backup `owner-provider-keys.backup-20261122043655`, "My router" key still remembered); ffmpeg installed (winget Gyan.FFmpeg, user scope); ALPR engine installed in %LOCALAPPDATA%\DAMAR\alpr (fast-alpr 0.4.0) — real eval 13 images: detected 12, exact 11, char 91.4%.
Next after all agents finish: consolidate into C:\Workspace\Damar on local branch `release/v1` via separate worktree (apps/desktop + canonical src changes), local commits only, no push.

Lead (Claude main) state: see execution-r6-checkpoint-01.md (P0 lock fix, startup marker, user witness, byte input bound, live inference + live agent turn, limits removed, workspace_shell, HTTPS custom endpoints). Last full safe suite: 305 tests, 295 pass, 10 fail (all from in-progress Control round 3).

Owner decisions: memory `damar-release-v1-decisions.md` and `feedback-remove-chatgpt-restrictions.md`.
