"use strict";

const { types } = require("node:util");
const { MAX_ADAPTER_RATE_HZ, EFFECTOR_KIND, REVERSIBILITY, HAZARD_CLASS, isPhysicalEffector } = require("./laws");
const isProxy = types.isProxy.bind(types);

const FIELDS = new Set([
    "effectorId", "deviceRef", "kind", "capabilityId", "reversibility",
    "hazardClass", "preconditionVerifiers", "postconditionVerifiers",
    "physicalLimits", "deadmanRequired", "calibrationRef", "maxRateHz"
]);
const text = (value, name, max = 128) => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw new TypeError(`invalid effector descriptor ${name}`);
    }
    return value;
};

function ownDataRecord(value, name) {
    if (!value || typeof value !== "object" || isProxy(value)) {
        throw new TypeError(`${name} must be a plain data record`);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${name} must be a plain data record`);
    const out = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new TypeError(`${name} has a non-string key`);
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value")) {
            throw new TypeError(`${name}.${key} must be a data property`);
        }
        out[key] = d.value;
    }
    return out;
}

function cloneBounded(value, depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 256 || depth > 6) throw new TypeError("physicalLimits exceed bounds");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (isProxy(value)) throw new TypeError("physicalLimits contain unsupported data");
    if (typeof value !== "object") throw new TypeError("physicalLimits contain unsupported data");
    if (Array.isArray(value)) throw new TypeError("physicalLimits arrays are not supported");
    const source = ownDataRecord(value, "physicalLimits");
    const result = Object.create(null);
    for (const key of Object.keys(source)) {
        if (key.length > 64 || key === "__proto__" || key === "constructor" || key === "prototype") {
            throw new TypeError("physicalLimits contain forbidden key");
        }
        result[key] = cloneBounded(source[key], depth + 1, budget);
    }
    return Object.freeze(result);
}

function validateEffectorDescriptor(input) {
    const source = ownDataRecord(input, "descriptor");
    for (const key of Object.keys(source)) if (!FIELDS.has(key)) throw new TypeError(`unknown descriptor field ${key}`);

    const kind = text(source.kind, "kind", 32);
    if (!Object.values(EFFECTOR_KIND).includes(kind)) throw new TypeError("invalid effector kind");
    // EM-7: a missing classification defaults to the STRICTEST value, so the
    // physical/non-physical decision must be made on the NORMALIZED hazard
    // class -- never on the raw input, where an omitted hazardClass would
    // otherwise let a descriptor validate as non-physical and then run
    // classified SAFETY_CRITICAL.
    const reversibility = source.reversibility === undefined ? REVERSIBILITY.IRREVERSIBLE : text(source.reversibility, "reversibility", 32);
    const hazardClass = source.hazardClass === undefined ? HAZARD_CLASS.SAFETY_CRITICAL : text(source.hazardClass, "hazardClass", 32);
    if (!Object.values(REVERSIBILITY).includes(reversibility)) throw new TypeError("invalid effector reversibility");
    if (!Object.values(HAZARD_CLASS).includes(hazardClass)) throw new TypeError("invalid effector hazardClass");
    const physical = isPhysicalEffector({ kind, hazardClass });
    const limits = source.physicalLimits === undefined || source.physicalLimits === null
        ? null
        : cloneBounded(source.physicalLimits);
    if (physical && (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).length === 0)) {
        throw new TypeError("physical effector requires declared physicalLimits");
    }
    if (physical) {
        for (const key of Object.keys(limits)) {
            const rule = limits[key];
            if (!rule || typeof rule !== "object" || !Number.isFinite(rule.min) || !Number.isFinite(rule.max) || rule.min > rule.max) {
                throw new TypeError(`invalid physical limit for ${key}`);
            }
            if ((rule.windowMs === undefined) !== (rule.maxPerWindow === undefined) ||
                (rule.windowMs !== undefined && (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0 ||
                    !Number.isFinite(rule.maxPerWindow) || rule.maxPerWindow < 0))) {
                throw new TypeError(`invalid cumulative physical limit for ${key}`);
            }
        }
    }
    const verifiers = (value, name) => {
        if (!Array.isArray(value) || isProxy(value) || value.length > 32) throw new TypeError(`invalid ${name}`);
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length") continue;
            if (typeof key !== "string" || !/^\d+$/.test(key) || Number(key) >= value.length) throw new TypeError(`invalid ${name}`);
        }
        const result = [];
        for (let i = 0; i < value.length; i++) {
            const d = Object.getOwnPropertyDescriptor(value, String(i));
            if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || typeof d.value !== "string" || d.value.length === 0 || d.value.length > 128) {
                throw new TypeError(`invalid ${name}`);
            }
            result.push(d.value);
        }
        return Object.freeze(result);
    };
    const maxRateHz = source.maxRateHz === undefined ? MAX_ADAPTER_RATE_HZ : source.maxRateHz;
    if (typeof maxRateHz !== "number" || !Number.isFinite(maxRateHz) || maxRateHz <= 0 || maxRateHz > MAX_ADAPTER_RATE_HZ) {
        throw new TypeError("invalid maxRateHz");
    }
    if (typeof source.deadmanRequired !== "boolean") throw new TypeError("deadmanRequired must be boolean");
    return Object.freeze({
        effectorId: text(source.effectorId, "effectorId"),
        deviceRef: text(source.deviceRef, "deviceRef"),
        kind,
        capabilityId: text(source.capabilityId, "capabilityId", 256),
        reversibility,
        hazardClass,
        preconditionVerifiers: verifiers(source.preconditionVerifiers, "preconditionVerifiers"),
        postconditionVerifiers: verifiers(source.postconditionVerifiers, "postconditionVerifiers"),
        physicalLimits: limits,
        deadmanRequired: source.deadmanRequired,
        calibrationRef: source.calibrationRef == null ? null : text(source.calibrationRef, "calibrationRef"),
        maxRateHz
    });
}

module.exports = Object.freeze({ validateEffectorDescriptor });
