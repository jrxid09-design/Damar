# EXTENSION KERNEL V1

Status: candidate (additive, production-unwired)
Branch: `feat/extension-kernel-v1`
Base: `9d72965`
Code: `src/extensions/**`, `tests/extensions/**`

## Purpose

Damar must evolve from "everything inside core" toward:

```
CORE + OPTIONAL CAPABILITIES
```

The Extension Kernel is the canonical foundation for extensions (Home
Assistant, OSINT, Serena, Graphify, Playwright, MCP, Matter, MQTT, vision /
device providers, community extensions). **V1 is the kernel only** — no
legacy integration is migrated, no extension code is ever executed.

## Core laws (enforced)

```
Installed != Enabled          Enabled != Healthy
Healthy != Authorized         Capability advertised != Capability granted
Extension != Authority        Extension != Core
Extension failure != Core failure
Manifest claim != trusted permission
Project activation != global activation
Discovery != execution        Configuration != authority
```

## Module layout

| File             | Responsibility                                                        |
|------------------|-----------------------------------------------------------------------|
| `errors.js`      | `ExtensionKernelError` + stable `reasonCode` contract                 |
| `ids.js`         | canonical `ExtensionId` / `ProjectId` / capability-name grammar       |
| `semver.js`      | strict semver parse/compare + minimal range language (`^ ~ = *`)      |
| `manifest.js`    | untrusted manifest parsing, closed schema, bounds                     |
| `lifecycle.js`   | closed state enum + validated transition table                        |
| `health.js`      | bounded/sanitized health reports                                       |
| `dependencies.js`| deterministic resolution, cycle detection (iterative DFS)             |
| `registry.js`    | `ExtensionRegistry` — the single owner of extension state             |
| `discovery.js`   | bounded discovery over explicitly configured roots; pure source port  |

## Identity rules

- Canonical grammar: lowercase segments `[a-z0-9-]`, dot-separated,
  total length 3..128. Uppercase is rejected outright, so case collisions are
  impossible by construction.
- Whitespace (incl. NBSP/BOM), path separators, scheme characters and
  reserved segments (`__proto__`, `constructor`, `prototype`, `proto`) are
  rejected.
- Identity comes ONLY from the parsed `extensionId` field — never from
  display names or folder names.
- Branded id objects are verified on every crossing; lookalike objects fail
  closed.

## Manifest contract

Closed schema (`schemaVersion: 1`; unknown fields rejected):

```jsonc
{
  "schemaVersion": 1,
  "extensionId": "community.homeassistant",
  "name": "Home Assistant",              // display only, not identity
  "version": "1.2.3",                    // strict semver
  "description": "...",                  // <=512 chars
  "category": "integration",             // closed enum
  "capabilities": ["environment.home.read"],        // advertisement ONLY
  "dependencies": [{"id": "core.mqtt", "versionRange": "^2.0.0", "optional": false}],
  "authorityRequirements": ["environment.device.control"], // descriptive ONLY
  "resources": {"cpuClass": "HEAVY", "memoryClass": "LIGHT", "durationClass": "SHORT"},
  "configuration": { ... },              // <=8 KiB JSON descriptor
  "projects": ["lab-7"],                 // descriptive applicability
  "runtime": {"damar": "^2.0.0"},
  "entrypoint": {"kind": "module", "path": "dist/index.js"}, // metadata ONLY, never loaded
  "trusted": true                        // recorded, NEVER honored
}
```

Manifests may be delivered as object, bounded JSON string, or Buffer.

## Lifecycle

States: `DISCOVERED INSTALLED DISABLED ENABLED STARTING HEALTHY DEGRADED
FAILED STOPPING UNAVAILABLE`. Every transition is validated against a closed
table BEFORE mutation (invalid transitions leave no partial state).

- Double enable/disable → deterministic `{changed:false}` results.
- Enable is atomic: dependency gate runs read-only first.
- `FAILED` allows explicit retry via enable; `UNAVAILABLE` is terminal in V1.
- Health reports accepted only in reportable states, through the trusted
  registry path.

## Capability semantics

Advertisement is inert metadata. The public surface contains no method that
grants, issues, authorizes, or mints anything. `authorityRequirements` are a
descriptive read-model for future execution layers, which will consult
canonical Authority separately. Proven by tests including a byte-compare of
the real `src/authority/store` surface before/after kernel operations.

## Authority / Governor boundaries

Structural audit (enforced as a test): no file under `src/extensions/` may
require `src/authority`, Resource Governor mutators, ToolBus, plugins,
child_process, net/http, eval, or `new Function`. Only intra-domain requires
plus `node:fs`/`node:path` (explicit-root discovery) are permitted. No timers
are created anywhere (proven with monkey-patched `setTimeout` etc.).

Resource declarations (`cpuClass`, ...) are descriptive data. No admission
decision is attempted — that remains exclusively the Resource Governor's job.

## Dependencies

Deterministic resolution: missing/disabled/version-mismatch required deps
block enable with explicit reasons; optional deps never block. Cycles are
detected across all declared edges (iterative DFS, normalized to start at
their lexicographically smallest member) and surfaced without wedging.
Dependencies are NEVER auto-enabled.

## Project activation

`installed globally -> enabled globally -> activated for project X`.
Activation requires global enablement, grants nothing else, and effective
state is the AND of both. Deactivation is always safe/idempotent. ProjectId
is an opaque canonical string contract; no second project subsystem exists.

## Bounds

| Bound                          | Value     |
|--------------------------------|-----------|
| manifest bytes                 | 64 KiB    |
| extensions per registry        | 512       |
| capabilities per extension     | 32        |
| dependencies per extension     | 16        |
| authority requirements         | 32        |
| diagnostic entries per report  | 32 (overflow dropped + counted) |
| diagnostic message length      | 256 chars |
| identifier length              | 128 chars |
| configuration descriptor/values| 8 KiB     |
| project activations/extension  | 256       |
| discovery results              | 256       |

## Persistence decision

V1 keeps all state **in memory**. `ExtensionRegistry.serializeState()`
produces a deterministic, frozen snapshot of canonical lifecycle/config
state (no live objects) — this is the persistence port shape for a future
store. Determinism is proven by running identical operation streams twice
and comparing snapshots byte-for-byte.

## Failure isolation & storm

Tests prove: bad manifests don't crash the registry; hostile diagnostic
payloads are sanitized/bounded; one failed health report doesn't touch other
extensions; enable failures are atomic; dependency cycles don't wedge;
returned views are deep-frozen clones.

Storm: **5200 deterministic mixed operations** (register/install/enable/
disable/health/activate/deactivate/malformed manifests/capability queries/
dependency reports) run twice with the same seed → identical SHA-256 digest
of outcomes+snapshot+cycles; registry size stays pinned at pool size; all
states coherent; cycle surfaced; zero async handles leaked.

## Known nonblocking observations

- Legacy `src/plugins/` (code-executing loader, weak validator) still exists
  untouched; migration is future work by design.
- Discovery scans exactly one directory level per configured root; deeper
  layouts can be added later as additional roots without contract change.
- `serializeState()` intentionally excludes manifest blobs; a future store
  would persist manifests separately keyed by canonical id.
