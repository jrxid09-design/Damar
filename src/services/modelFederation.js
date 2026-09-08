"use strict";

const crypto = require("node:crypto");
const identity = require("./pandawaIdentity");

const FAILURE_CLASSES = Object.freeze(["AUTH_FAILURE", "RATE_LIMIT", "MODEL_NOT_FOUND", "PROVIDER_UNAVAILABLE", "NETWORK_FAILURE", "CONNECT_TIMEOUT", "READ_TIMEOUT", "STREAM_FAILURE", "INVALID_RESPONSE", "EMPTY_RESPONSE", "CONTEXT_OVERFLOW", "UNSUPPORTED_CAPABILITY", "TOOL_PROTOCOL_FAILURE", "POLICY_DENIED", "LOCAL_RUNTIME_FAILURE"]);
const HEALTH = Object.freeze(["HEALTHY", "DEGRADED", "RATE_LIMITED", "CIRCUIT_OPEN", "HALF_OPEN", "UNAVAILABLE", "MISCONFIGURED"]);
const ROUTING_MODES = Object.freeze(["FIXED", "SMART", "HYBRID"]);
const PRIVACY = Object.freeze(["LOCAL", "PRIVATE_REMOTE", "TRUSTED_CLOUD", "EXTERNAL_CLOUD", "UNKNOWN"]);
const MAX_KEYS = 512;

function text(v, name, max = 512) { if (typeof v !== "string" || !v.trim() || v.length > max) throw new TypeError(`${name}_INVALID`); return v.trim(); }
function entity(v) { if (String(v).toLowerCase() === "damar") return "damar"; return identity.assertPandawaId(v); }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
function parseKeys(input) {
    if (input === undefined || input === null) return [];
    if (typeof input !== "string" && !Array.isArray(input)) throw new TypeError("CREDENTIALS_INVALID");
    const values = (Array.isArray(input) ? input : input.split(/[\n,;]+/)).map(v => String(v).trim()).filter(Boolean);
    const unique = [...new Set(values)];
    if (unique.length > MAX_KEYS || unique.some(v => v.length > 4096)) throw new RangeError("CREDENTIAL_POOL_BOUNDED");
    return unique;
}
function fingerprint(secret) { return `••••${crypto.createHash("sha256").update(secret).digest("hex").slice(-8)}`; }
function classifyFailure(error) {
    if (error?.failureClass && FAILURE_CLASSES.includes(error.failureClass)) return error.failureClass;
    const status = Number(error?.status ?? error?.statusCode);
    if (status === 401 || status === 403) return "AUTH_FAILURE";
    if (status === 404) return "MODEL_NOT_FOUND";
    if (status === 408) return "CONNECT_TIMEOUT";
    if (status === 429) return "RATE_LIMIT";
    if (status >= 500) return "PROVIDER_UNAVAILABLE";
    const code = String(error?.code ?? "").toUpperCase();
    if (code.includes("TIMEOUT")) return code.includes("READ") ? "READ_TIMEOUT" : "CONNECT_TIMEOUT";
    if (code.includes("ECONN") || code.includes("ENOTFOUND") || code.includes("NETWORK")) return "NETWORK_FAILURE";
    return "INVALID_RESPONSE";
}
function publicModel(model) {
    return Object.freeze({ id: text(model.id, "MODEL_ID"), name: String(model.name ?? model.id), context: model.context ?? null, vision: model.vision ?? "UNKNOWN", tools: model.tools ?? "UNKNOWN", reasoning: model.reasoning ?? "UNKNOWN", streaming: model.streaming ?? "UNKNOWN", structuredOutput: model.structuredOutput ?? "UNKNOWN", health: model.health ?? "UNKNOWN" });
}

class ProviderFederation {
    constructor({ vault, store = null, now = () => Date.now(), cooldownMs = 30000, failureThreshold = 3 } = {}) {
        if (!vault || typeof vault.create !== "function" || typeof vault.resolve !== "function") throw new TypeError("VAULT_REQUIRED");
        this.vault = vault; this.store = store; this.now = now; this.cooldownMs = cooldownMs; this.failureThreshold = failureThreshold;
        this.providers = new Map(); this.adapters = new Map();
    }
    addProvider({ providerId, displayName, protocol = "openai-compatible", baseUrl, keys = [], privacyClass = "UNKNOWN", adapter = null, metadata = {} } = {}) {
        const idv = text(providerId, "PROVIDER_ID").toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(idv)) throw new TypeError("PROVIDER_ID_INVALID");
        if (!PRIVACY.includes(privacyClass)) throw new TypeError("PRIVACY_CLASS_INVALID");
        const refs = parseKeys(keys).map((key, index) => this.vault.create({ value: key, label: `provider:${idv}:credential:${index + 1}`, scope: { kind: "provider", key: idv } }).ref);
        const profile = { providerId: idv, displayName: text(displayName || idv, "DISPLAY_NAME"), protocol: text(protocol, "PROTOCOL"), baseUrl: text(baseUrl || "local://unsupported", "BASE_URL", 2048), credentialPoolRef: id(`pool_${idv}`), credentialRefs: refs, discoveredModels: [], healthState: "HEALTHY", privacyClass, metadata: { ...metadata }, failures: 0, cooldownUntil: 0, circuit: "CLOSED" };
        this.providers.set(idv, profile); if (adapter) this.adapters.set(idv, adapter); return this.describeProvider(idv);
    }
    describeProvider(providerId) { const p = this.providers.get(String(providerId).toLowerCase()); if (!p) return null; return Object.freeze({ providerId: p.providerId, displayName: p.displayName, protocol: p.protocol, baseUrl: p.baseUrl, credentialPoolRef: p.credentialPoolRef, credentialCount: p.credentialRefs.length, credentialFingerprints: p.credentialRefs.map((ref, i) => Object.freeze({ index: i + 1, ref, fingerprint: "[vault-ref]", state: p.credentialState?.[i] ?? "HEALTHY" })), discoveredModels: p.discoveredModels.map(publicModel), healthState: p.healthState, privacyClass: p.privacyClass, metadata: { ...p.metadata }, survival: false }); }
    listProviders() { return [...this.providers.keys()].map(idv => this.describeProvider(idv)); }
    async scanModels(providerId, { manualModels = [] } = {}) {
        const p = this._provider(providerId); const adapter = this.adapters.get(p.providerId); let models;
        if (adapter?.scanModels) models = await adapter.scanModels({ profile: this.describeProvider(p.providerId), credentialRefs: [...p.credentialRefs] });
        else models = manualModels;
        if (!Array.isArray(models)) throw Object.assign(new Error("MODEL_LIST_INVALID"), { failureClass: "INVALID_RESPONSE" });
        p.discoveredModels = models.map(publicModel); return p.discoveredModels.map(x => ({ ...x }));
    }
    async testProvider(providerId) { const p = this._provider(providerId); const adapter = this.adapters.get(p.providerId); if (!adapter?.testCredential) return { ok: false, failureClass: "UNSUPPORTED_CAPABILITY" }; try { const result = await adapter.testCredential({ profile: this.describeProvider(p.providerId) }); this._success(p); return { ok: result !== false, providerId: p.providerId }; } catch (error) { return this._failure(p, error); } }
    async invoke(providerId, request) {
        const p = this._provider(providerId); const adapter = this.adapters.get(p.providerId); if (!adapter?.invoke) throw Object.assign(new Error("PROVIDER_ADAPTER_UNAVAILABLE"), { failureClass: "PROVIDER_UNAVAILABLE" });
        if (p.circuit === "OPEN") { if (this.now() < p.cooldownUntil) throw Object.assign(new Error("PROVIDER_CIRCUIT_OPEN"), { failureClass: "PROVIDER_UNAVAILABLE" }); p.circuit = "HALF_OPEN"; p.healthState = "HALF_OPEN"; }
        if (!p.credentialRefs.length && p.privacyClass !== "LOCAL") throw Object.assign(new Error("CREDENTIAL_POOL_EMPTY"), { failureClass: "AUTH_FAILURE" });
        let last;
        for (let i = 0; i < Math.min(p.credentialRefs.length || 1, MAX_KEYS); i++) {
            const index = this._nextCredential(p); const secret = p.credentialRefs[index] ? this.vault.resolve(p.credentialRefs[index]) : null;
            try { const result = await adapter.invoke({ ...request, apiKey: secret?.ok ? secret.value.reveal() : null, credentialIndex: index }); this._success(p, index); return result; } catch (error) { last = error; this._failure(p, error, index); if (!["AUTH_FAILURE", "RATE_LIMIT", "CONNECT_TIMEOUT", "READ_TIMEOUT", "NETWORK_FAILURE"].includes(classifyFailure(error))) break; }
        }
        throw last || Object.assign(new Error("PROVIDER_UNAVAILABLE"), { failureClass: "PROVIDER_UNAVAILABLE" });
    }
    _provider(idv) { const p = this.providers.get(String(idv).toLowerCase()); if (!p) throw Object.assign(new Error("PROVIDER_NOT_FOUND"), { failureClass: "PROVIDER_UNAVAILABLE" }); return p; }
    _nextCredential(p) { p.credentialState ??= []; p.credentialCooldownUntil ??= []; const now = this.now(); const candidates = p.credentialRefs.map((_, i) => i).filter(i => !["INVALID", "COOLDOWN", "DEGRADED"].includes(p.credentialState[i]) || now >= (p.credentialCooldownUntil[i] ?? 0)); return candidates[0] ?? 0; }
    _success(p, index = null) { p.failures = 0; p.circuit = "CLOSED"; p.healthState = "HEALTHY"; if (index !== null) { p.credentialState ??= []; p.credentialState[index] = "HEALTHY"; p.credentialCooldownUntil ??= []; p.credentialCooldownUntil[index] = 0; } }
    _failure(p, error, index = null) { const kind = classifyFailure(error); p.failures++; p.healthState = kind === "RATE_LIMIT" ? "RATE_LIMITED" : "DEGRADED"; p.credentialState ??= []; p.credentialCooldownUntil ??= []; if (index !== null) { p.credentialState[index] = kind === "AUTH_FAILURE" ? "INVALID" : kind === "RATE_LIMIT" ? "COOLDOWN" : "DEGRADED"; p.credentialCooldownUntil[index] = this.now() + this.cooldownMs; } if (p.failures >= this.failureThreshold) { p.circuit = "OPEN"; p.cooldownUntil = this.now() + this.cooldownMs; p.healthState = "CIRCUIT_OPEN"; } return { ok: false, providerId: p.providerId, failureClass: kind, healthState: p.healthState }; }
}

class EntityModelFederation {
    constructor({ providers, wises, defaultRoute = null } = {}) { if (!providers || !wises) throw new TypeError("FEDERATION_DEPENDENCIES_REQUIRED"); this.providers = providers; this.wises = wises; this.defaultRoute = defaultRoute ? this.route(defaultRoute) : null; this.assignments = new Map(); }
    assign(entityId, { primaryRoute = null, configuredFallbacks = [], routingMode = "HYBRID", policy = {} } = {}) { const entityKey = entity(entityId); if (!ROUTING_MODES.includes(routingMode)) throw new TypeError("ROUTING_MODE_INVALID"); const profile = { entityId: entityKey, primaryRoute: primaryRoute ? this.route(primaryRoute) : null, configuredFallbacks: configuredFallbacks.map(x => this.route(x)), routingMode, policy: { ...policy } }; this.assignments.set(entityKey, profile); return this.describe(entityKey); }
    describe(entityId) { const p = this.assignments.get(entity(entityId)); return p ? Object.freeze({ entityId: p.entityId, primaryRoute: p.primaryRoute && { ...p.primaryRoute }, configuredFallbacks: p.configuredFallbacks.map(x => ({ ...x })), routingMode: p.routingMode, policy: { ...p.policy }, systemFallback: { survivalRole: this.wises.profile.survivalRole, providerId: this.wises.profile.providerId, modelId: this.wises.profile.modelId } }) : null; }
    route(route) { if (!route || typeof route !== "object") throw new TypeError("MODEL_ROUTE_INVALID"); return Object.freeze({ providerId: text(route.providerId, "PROVIDER_ID"), modelId: text(route.modelId, "MODEL_ID") }); }
    resolve(entityId, { sessionOverride = null, workOverride = null } = {}) { const key = entity(entityId); const fallback = { providerId: this.wises.profile.providerId, modelId: this.wises.profile.modelId }; return this.route(workOverride || sessionOverride || this.assignments.get(key)?.primaryRoute || this.defaultRoute || fallback); }
    async invoke(entityId, request, { sessionOverride = null, workOverride = null } = {}) {
        const key = entity(entityId); const assignment = this.assignments.get(key); const routes = [workOverride, sessionOverride, assignment?.primaryRoute, ...(assignment?.configuredFallbacks || []), !assignment && this.defaultRoute].filter(Boolean).map(x => this.route(x)); const attempts = []; for (const route of routes) { try { const result = await this.providers.invoke(route.providerId, { ...request, model: route.modelId, entityId: key }); return { ...result, entityId: key, requestedRoute: route, actualRoute: route, fallback: false, attempts }; } catch (error) { attempts.push({ route, failureClass: classifyFailure(error) }); } }
        try {
            const local = await this.wises.invoke({ ...request, entityId: key, model: this.wises.profile.modelId, entityProjection: boundedEntityProjection(key, request) });
            return { ...local, entityId: key, actualRoute: { providerId: this.wises.profile.providerId, modelId: this.wises.profile.modelId }, survivalRole: this.wises.profile.survivalRole, fallback: true, attempts };
        } catch (error) {
            return { entityId: key, actualRoute: { providerId: this.wises.profile.providerId, modelId: this.wises.profile.modelId }, survivalRole: this.wises.profile.survivalRole, fallback: true, degraded: true, failureClass: classifyFailure(error), attempts };
        }
    }
}

function boundedEntityProjection(entityId, request = {}) { const source = request.entityProjection && typeof request.entityProjection === "object" ? request.entityProjection : {}; const list = value => Array.isArray(value) ? value.slice(0, 32).filter(v => typeof v === "string").map(v => v.slice(0, 256)) : []; const continuation = request.continuation && typeof request.continuation === "object" ? request.continuation : {}; const completed = list(continuation.completedActionRefs); const verified = list(continuation.verifiedActionRefs); const pending = list(continuation.pendingActionRefs).filter(v => !completed.includes(v) && !verified.includes(v)); return Object.freeze({ entityId, displayName: typeof source.displayName === "string" ? source.displayName.slice(0, 128) : null, role: typeof source.role === "string" ? source.role.slice(0, 128) : null, sessionId: typeof source.sessionId === "string" ? source.sessionId.slice(0, 256) : null, taskRef: typeof source.taskRef === "string" ? source.taskRef.slice(0, 256) : null, contextRefs: list(source.contextRefs), skillRefs: list(source.skillRefs), continuation: Object.freeze({ workRef: typeof continuation.workRef === "string" ? continuation.workRef.slice(0, 256) : null, phase: typeof continuation.phase === "string" ? continuation.phase.slice(0, 64) : null, completedActionRefs: completed, verifiedActionRefs: verified, pendingActionRefs: pending, resultRefs: list(continuation.resultRefs) }) }); }

module.exports = Object.freeze({ FAILURE_CLASSES, HEALTH, ROUTING_MODES, PRIVACY, parseKeys, classifyFailure, boundedEntityProjection, ProviderFederation, EntityModelFederation });
