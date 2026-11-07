# DAMAR

**A local-first, governed AI assistant runtime.** DAMAR separates model reasoning from permission to act. Plans, tool calls, and automation must respect the runtime's authority and verification boundaries.

![DAMAR](docs/assets/readme/damar-hero.svg)

> **Project status:** active development. This repository is not a certified production release. Feature availability and security acceptance must be verified against the running build and its tests; architecture documents are not proof of deployment.

## What is in this repository?

- **Runtime and CLI:** local host, orchestration, providers, memory, and capability interfaces (`src/`, `scripts/`, `providers/`).
- **Console and interfaces:** user-facing application and assets (`apps/`).
- **Authority and safety:** action gating, verification, denial, and regression tests (`src/authority/`, `src/security/`, `tests/`).
- **Integrations:** optional tools and adapters; their presence in source does not imply they are configured or authorized.
- **Technical documentation:** architecture and component contracts (`docs/architecture/`).

The AI-consciousness and self-model work is a **research and engineering objective**, not a verified claim that the system is conscious.

## Local development

The repository's Node.js CI targets **Node 22 and Node 24**. Some dependencies use native modules or a pinned Git source, so installation prerequisites vary by operating system.

```bash
git clone https://github.com/jrxid09-design/Damar.git
cd Damar
npm ci
npm run cli
```

Additional commands defined by `package.json`:

```bash
npm start                # server
npm run damar            # console launcher
npm test                 # regression suite
```

Read `.env.example` and the relevant integration documentation before configuring providers or credentials. Never commit local secrets, session stores, real infrastructure locations, or runtime state. A successful installation is not authorization to perform external actions.

**Dependency security:** the CI workflow checks the dependency lockfile against an explicitly approved digest before `npm ci`. Changes to that digest, CI, or dependency policy must be reviewed under the repository's protected-change process. A local test pass does not replace GitHub protection or release approval.

## Standalone component repositories

DAMAR is the host/orchestrator. Standalone source repositories can have different prerequisites and separate security/acceptance boundaries.

| Component | Official source | Integration note |
| --- | --- | --- |
| DAMAR Cognitive Runtime V3 | [medlest/damar-cognitive-runtime](https://github.com/medlest/damar-cognitive-runtime) | Separate Python runtime. See the [standalone handoff README](https://github.com/medlest/damar-cognitive-runtime/blob/standalone-v3-handoff-20261104/README.md). Access may require repository permission. Integration into main DAMAR is gated; it is not automatically installed by cloning this repository. |
| DMR-01 / DAMAR HID firmware | **Official standalone repository not yet confirmed** | Firmware and hardware qualification are separate. No verified upstream URL or flash-ready production release is claimed here. The maintainer's confirmed URL will be linked when available. |

No unofficial repository is presented as the authoritative HID source.

## Governed execution

![Governed flow](docs/assets/readme/damar-governed-flow.svg)

```text
Observation -> proposal -> authority check -> approved action
                                             -> effect verification -> audit
                 \-> denial (no protected action)
```

Core rule: **a model may propose, but only the authorized runtime can permit execution**. Tool availability, model confidence, or an evaluation fixture must never substitute for an owner-bound permission decision.

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | Runtime and application source |
| `apps/` | Console and client interfaces |
| `scripts/` | Supported runtime, build, and dependency-policy scripts |
| `tests/` | Automated tests and security regression fixtures |
| `docs/architecture/` | Architecture and retained Wave 6 interface contracts |
| `configs/` / `.env.example` | Configuration templates, not live credentials |
| `.github/` | CI configuration and review ownership |
| `DamarSelf/` | Non-private identity and continuity templates |

Generated reports, caches, editor/AI-agent instructions, private runtime state, and internal reviewer evidence are **not part of the public source distribution**. Repository history and acceptance evidence are maintained separately.

## License and scope

See [LICENSE](LICENSE) for the repository's licensing terms. External dependencies and standalone components may carry separate licenses. The presence of a capability or diagram does not imply operational readiness, certification, or permission to deploy it.
