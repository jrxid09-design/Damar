# Changelog

All notable changes to DAMAR will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

DAMAR is in pre-release development toward 1.0.0. The current state of the
`develop` branch includes:

### Added

- DAMAR Core: a local service that hosts sessions, model grants, usage
  receipts, and the Control dashboard.
- DAMAR CLI: a terminal agent with permission cards for consequential
  actions, contained command execution, undo/redo, resumable sessions, and
  project memory.
- DAMAR Control: a browser dashboard for providers, model grants,
  sessions, usage, settings, and security state.
- DAMAR Presence: Idle Presence and the Damar Notch companion surface,
  including approval requests answered from the Notch.
- Mata Dewa: an opt-in panel of public world feeds (earthquakes, weather,
  air quality, flights, satellites, launches), with a proactive alert
  framework (configurable rules, channels, and quiet hours).
- An MCP endpoint with grant-proof based access for external agent
  clients, and a federation layer for external agents.
- A computer-use substrate in Core (screen perception, OS input actions,
  verification loop) behind the Authority Gate.

### Notes

- A Windows desktop installer build (1.0.0) exists as an unsigned release
  candidate; it has not been published as a stable release.
- The only pre-release tag in the repository history is `v0.1.0-alpha`.
  Changes from before this changelog was introduced are recorded in the
  git history.
