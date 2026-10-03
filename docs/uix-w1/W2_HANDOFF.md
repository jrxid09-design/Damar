# UIX-W2 handoff from W1 product truth

Current W1 truth is source-backed at `19c3c9f543aa380d7732e9a9cdafd8179c71048b` plus the targeted artifact repair. The terminal WebSocket code boundary remains partial and is not currently user-reachable: `src/ws/terminalGateway.js` returns HTTP 503 before authentication/session attachment. Do not present terminal streaming as a current user-ready surface.

The current model/provider inventory contains five records, including the
source-backed local in-process `llamacpp` provider. Its adapter, configuration,
GGUF model discovery, assignment, health status, fallback rule, and active
provider gateway path exist, but runtime readiness remains configuration/model
dependent. There is no provider-management UI, multi-instance gateway, role
routing, key-pool, quota, or ordered-fallback surface in W1.

Build against the existing HTTP/API, CLI, Telegram/WhatsApp, voice, companion,
MCP, and currently non-attachable terminal boundaries. Reuse `product_feature_map.json`, the L11
reachability matrix, the API/read-model catalogs, and the canonical runtime
composition. The Web Dashboard is not a production UI at this SHA; Idle/
Presence is product direction, not an implemented visual surface.

W2 must not duplicate RuntimeHost, Manager, Context Pipeline, World Model,
Sensorium, capability registry, Authority Gate, verification, Audit Ledger,
device identity, or provider truth. UI actions must enter the existing Manager →
ActionIntent → Authority → capability/actuation → verification → audit path.
Observations are bounded context evidence and never authority. External agents,
plugins, MCP servers, providers, and channels are integrations, not Damar
orchestrators or authority owners.

The remaining missing primitives are explicit in
`data/missing_primitive_register.json`; none blocks the current W1 candidate.
