# 16 Authority path map

Canonical boundary: src/authority/productionComposition.js. Action grammar: src/action/intent.js. Manager composition is private in src/manager/internal/managerBootstrap.js. Execution: canonicalCapabilityExecution.js. Verification and audit use canonical registrations/ledger.

Path: request -> Manager admission -> ActionIntent -> authority evaluation -> exact capability/operation -> actuator -> verification -> audit.

Manager, model, plan, memory, plugin registry, event, detection, UI/API button, HMAC, and replay cache are not authority. Dexec additionally requires frozen intent, authority artifact, lease/routing witness and verification. Deny until ratified.

