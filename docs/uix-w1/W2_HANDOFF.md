# UIX-W2 handoff from W1 product truth

Current W1 truth is source-backed at `b2d098684a5e2740f1c7dc0d6692ca3033d2e216`.

Build against the existing HTTP/API, CLI, Telegram/WhatsApp, voice, companion,
MCP, and terminal boundaries. Reuse `product_feature_map.json`, the L11
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
