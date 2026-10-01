# 26 Missing primitive register

Primary unlocks: unified capability metadata/read model; runtime/approval event contract; provider instance/health routing; canonical device trust projection; DCD response proposal/read model; durable cross-surface approval relay.

W1 candidate repair added a narrow context-capability projection bridge at
`src/ai/capability/ContextCapabilityIntegration.js`, composed at the existing
AI tool-selection boundary. It is a non-authoritative runtime view only; the
broader unified metadata/read model and the other primitives remain missing.
This record is not certification. Machine register: data/missing_primitive_register.json.

Repair 3 correction: production composition now propagates the canonical V1
CapabilityRegistry through RuntimeOptions into AIRuntime.resolveTools. The
projection preserves the existing `UNKNOWN` state
for unjoined AITools and for missing positive evidence. `available`,
`runtimeReachable`, and `executable` are true only for an explicit V1 join
with AVAILABLE state and SATISFIED dependencies; explicit negative evidence is
false, and unknown remains inspectable but is not advertised as ready. V1
dependency readiness requires every dependency to have an AVAILABLE
observation. The former `DAMAR_CONTEXT_PIPELINE=legacy` branch is no longer
runtime-reachable; `src/ai/context/Pipeline.js` remains the canonical context
owner. This is still a read-only projection, not a unified lifecycle model.
F-CAP-005 remains closed at its projection scope; F-CAP-009 and F-CTX-008 are
candidate implemented/tested after Repair 3, pending fresh independent
re-audit. F-CTX-003, F-CTX-004, F-CAP-006, and F-CAP-007 remain visibly
deferred/open. This record is not certification.
