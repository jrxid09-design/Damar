"use strict";

const { types } = require("node:util");
const { MAX_ADAPTER_RATE_HZ, isPhysicalEffector } = require("./laws");
const isProxy = types.isProxy.bind(types);
const REQUEST_FIELDS = Object.freeze([
    "executionId", "intentId", "capabilityId", "operation", "principal", "scope", "parameters"
]);

function cloneBounded(value, depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 512 || depth > 8) throw new TypeError("effector request exceeds bounds");
    if (typeof value === "string") {
        if (value.length > 4096) throw new TypeError("effector request string exceeds bound");
        return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || isProxy(value)) throw new TypeError("effector request contains unsupported data");
    if (Array.isArray(value)) {
        if (value.length > 1024) throw new TypeError("effector request array exceeds bounds");
        const result = [];
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length") continue;
            if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= value.length) throw new TypeError("effector request array has extra fields");
        }
        for (let i = 0; i < value.length; i++) {
            const d = Object.getOwnPropertyDescriptor(value, String(i));
            if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || !d.enumerable) throw new TypeError("effector request array must contain data items");
            result.push(cloneBounded(d.value, depth + 1, budget));
        }
        return Object.freeze(result);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("effector request records must be plain");
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype" || key.length > 128) {
            throw new TypeError("effector request has a forbidden key");
        }
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || !d.enumerable) throw new TypeError("effector request must use enumerable data properties");
        result[key] = cloneBounded(d.value, depth + 1, budget);
    }
    return Object.freeze(result);
}

function extractParameters(value, descriptor) {
    if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) throw new TypeError("parameters must be a plain record");
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("parameters must be a plain record");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) throw new TypeError("parameters exceed key bound");
    const result = Object.create(null);
    for (const key of keys) {
        if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype" || key.length > 128) {
            throw new TypeError("parameters contain a forbidden key");
        }
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || !d.enumerable) throw new TypeError("parameters must use enumerable data properties");
        if (isPhysicalEffector(descriptor)) {
            const rule = descriptor.physicalLimits && descriptor.physicalLimits[key];
            if (!rule || typeof d.value !== "number" || !Number.isFinite(d.value)) throw new TypeError(`undeclared or nonnumeric physical parameter '${key}'`);
            result[key] = d.value;
        } else {
            result[key] = cloneBounded(d.value);
        }
    }
    return Object.freeze(result);
}

function validatedRequestSnapshot(value, descriptor) {
    if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) throw new TypeError("gated request must be a plain record");
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("gated request must be a plain record");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== REQUEST_FIELDS.length) throw new TypeError("gated request fields do not match the canonical schema");
    for (const key of keys) {
        if (typeof key !== "string" || !REQUEST_FIELDS.includes(key)) {
            throw new TypeError("gated request fields do not match the canonical schema");
        }
    }
    const source = Object.create(null);
    for (const key of REQUEST_FIELDS) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || !d.enumerable) throw new TypeError("gated request must use enumerable data properties");
        source[key] = d.value;
    }
    if (typeof source.executionId !== "string" || !source.executionId || source.executionId.length > 128 ||
        typeof source.intentId !== "string" || !source.intentId || source.intentId.length > 128 ||
        source.capabilityId !== descriptor.capabilityId || typeof source.operation !== "string" || !source.operation ||
        typeof source.principal !== "string" || !source.principal || source.principal.length > 128 || source.operation.length > 256) {
        throw new TypeError("gated request has invalid canonical fields");
    }
    const scope = cloneBounded(source.scope);
    if (!Array.isArray(scope) || scope.length > 1024) throw new TypeError("gated request scope is invalid");
    for (const entry of scope) if (typeof entry !== "string" || entry.length > 256) throw new TypeError("gated request scope is invalid");
    return Object.freeze({
        executionId: source.executionId,
        intentId: source.intentId,
        capabilityId: source.capabilityId,
        operation: source.operation,
        principal: source.principal,
        scope,
        parameters: extractParameters(source.parameters, descriptor)
    });
}

function createLimitState() {
    return { lastCommandAtMs: null, windows: new Map(), inFlight: false };
}

function checkCommandLimits(descriptor, parameters, state, nowMs) {
    if (!descriptor || !state || typeof nowMs !== "number" || !Number.isFinite(nowMs)) return Object.freeze({ allowed: false, reason: "INVALID_LIMIT_CONTEXT" });
    try { parameters = extractParameters(parameters, descriptor); } catch { return Object.freeze({ allowed: false, reason: "INVALID_PARAMETERS" }); }
    if (state.inFlight) return Object.freeze({ allowed: false, reason: "COMMAND_IN_FLIGHT" });
    if (state.lastCommandAtMs !== null && nowMs < state.lastCommandAtMs) return Object.freeze({ allowed: false, reason: "CLOCK_ROLLBACK" });
    const rate = Math.min(MAX_ADAPTER_RATE_HZ, descriptor.maxRateHz || MAX_ADAPTER_RATE_HZ);
    const interval = 1000 / rate;
    if (state.lastCommandAtMs !== null && nowMs - state.lastCommandAtMs < interval) {
        return Object.freeze({ allowed: false, reason: "RATE_LIMIT" });
    }
    const declared = descriptor.physicalLimits;
    if (isPhysicalEffector(descriptor) && (!declared || typeof declared !== "object")) {
        return Object.freeze({ allowed: false, reason: "MISSING_PHYSICAL_LIMITS" });
    }
    if (declared && parameters && typeof parameters === "object") {
        for (const key of Object.keys(parameters)) {
            const rule = declared[key];
            const value = parameters[key];
            if (isPhysicalEffector(descriptor) && typeof value === "number" && !rule) {
                return Object.freeze({ allowed: false, reason: "UNDECLARED_PHYSICAL_PARAMETER", parameter: key });
            }
            if (typeof value !== "number") continue;
            if (!rule || typeof rule !== "object" || !Number.isFinite(rule.min) || !Number.isFinite(rule.max) ||
                value < rule.min || value > rule.max) {
                return Object.freeze({ allowed: false, reason: "LIMIT_REFUSAL", parameter: key });
            }
            if (Number.isFinite(rule.windowMs) && Number.isFinite(rule.maxPerWindow)) {
                const retained = (state.windows.get(key) || []).filter((item) => item.atMs > nowMs - rule.windowMs);
                state.windows.set(key, retained);
                const total = retained.reduce((sum, item) => sum + item.amount, 0);
                if (total + Math.abs(value) > rule.maxPerWindow) {
                    return Object.freeze({ allowed: false, reason: "WINDOW_LIMIT_REFUSAL", parameter: key });
                }
            }
        }
    }
    return Object.freeze({ allowed: true, reason: null });
}

function recordCommand(descriptor, parameters, state, nowMs) {
    parameters = extractParameters(parameters, descriptor);
    state.lastCommandAtMs = nowMs;
    const declared = descriptor.physicalLimits;
    if (declared && parameters && typeof parameters === "object") {
        for (const key of Object.keys(parameters)) {
            const rule = declared[key];
            if (!rule || !Number.isFinite(rule.windowMs) || rule.windowMs <= 0 || !Number.isFinite(rule.maxPerWindow)) continue;
            const retained = (state.windows.get(key) || []).filter((item) => item.atMs > nowMs - rule.windowMs);
            retained.push({ atMs: nowMs, amount: Math.abs(parameters[key]) });
            state.windows.set(key, retained);
        }
    }
}

module.exports = Object.freeze({ createLimitState, checkCommandLimits, recordCommand, extractParameters, validatedRequestSnapshot });
