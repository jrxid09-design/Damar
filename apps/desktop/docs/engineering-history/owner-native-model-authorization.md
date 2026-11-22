# Owner approval and execution gate

Owner explicitly approved cx/gpt-6-luna for isolated Core port 29785 only, using NineRouter and the Core-held credential within previously approved live limits. This file records the conversation approval; it is NOT a Core policy grant or activation receipt.

Target verified read-only:
- Core directory: D:/Damar/R9_WORK/r7r3-scratch/damar-owner-reopen-20261118-155022/session
- Port: 29785
- Configuration version: db4116e4-daec-47dd-b8e5-98b90feb19ac:1
- ninerouter hasKey=true, keyRemembered=true, model=null, executable=false
- lifecycle READY; all outstanding work counters zero

Execution blocked: Core provider policy is a code constant APPROVED_LIVE_MODEL=9router/cx/gpt-6-luna, checked in registry connect/select and runtime dispatch. Existing authenticated settings and provider routes expose no candidate-scoped model-authorization grant, durable grant audit, or policy reload. Changing the constant would change all candidates using the source; editing a file cannot update the already-running module. No alias equivalence established.

No policy mutation, credential read/export/replacement, model selection or inference performed. No active Core restarted. Required engineering capability: Core-owned session-scoped grant with durable audit/readback, validated at all model/dispatch gates, then explicitly authorized lifecycle reload to load that implementation into the existing running Core. Previously authorized request/token/spend limits must be recovered as exact values before a metered run; no values inferred from this approval.
