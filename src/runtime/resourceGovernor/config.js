"use strict";

const { freezeDeep, isFiniteNumber } = require("./model");

const KNOWN_GROUPS = Object.freeze([
    "llm-heavy", "re-analysis", "voice", "tool",
    "background", "tests", "default"
]);

function fail(msg) { throw new Error(`INVALID_RESOURCE_GOVERNOR_CONFIG: ${msg}`); }

function intInRange(v, min, max, name) {
    if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be an integer in [${min},${max}]`);
    return v;
}

function numInRange(v, min, max, name) {
    if (!isFiniteNumber(v) || v < min || v > max) fail(`${name} must be a number in [${min},${max}]`);
    return v;
}

function orderedBands(bands, name) {
    if (bands === null || typeof bands !== "object") fail(`${name} must be an object`);
    const { elevated, high, critical } = bands;
    numInRange(elevated, 0, 1e12, `${name}.elevated`);
    numInRange(high, 0, 1e12, `${name}.high`);
    numInRange(critical, 0, 1e12, `${name}.critical`);
    if (!(elevated < high && high <= critical)) {
        fail(`${name} thresholds must satisfy elevated < high <= critical`);
    }
    return { elevated, high, critical };
}

function validateGroupLimits(groupLimits) {
    if (groupLimits === null || typeof groupLimits !== "object" || Array.isArray(groupLimits)) {
        fail("groupLimits must be an object");
    }
    const out = {};
    for (const [name, limit] of Object.entries(groupLimits)) {
        if (!KNOWN_GROUPS.includes(name)) fail(`unknown group "${name}" — group name set is closed`);
        out[name] = intInRange(limit, 1, 1024, `groupLimits.${name}`);
    }
    for (const g of KNOWN_GROUPS) {
        if (!(g in out)) out[g] = out.default ?? 4;
    }
    return out;
}

function validateClassLimits(classConcurrencyLimits) {
    if (classConcurrencyLimits === undefined || classConcurrencyLimits === null) return {};
    if (typeof classConcurrencyLimits !== "object" || Array.isArray(classConcurrencyLimits)) {
        fail("classConcurrencyLimits must be an object");
    }
    const out = {};
    for (const [cls, limit] of Object.entries(classConcurrencyLimits)) {
        out[cls] = intInRange(limit, 1, 1024, `classConcurrencyLimits.${cls}`);
    }
    return out;
}

function validateResourceGovernorConfig(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        fail("config must be a plain object");
    }
    const globalConcurrencyLimit = intInRange(raw.globalConcurrencyLimit ?? 8, 1, 1024, "globalConcurrencyLimit");
    const groupLimits = validateGroupLimits(raw.groupLimits ?? {});
    for (const [g, lim] of Object.entries(groupLimits)) {
        if (lim > globalConcurrencyLimit) fail(`groupLimits.${g} exceeds globalConcurrencyLimit`);
    }
    const classConcurrencyLimits = validateClassLimits(raw.classConcurrencyLimits);
    for (const [c, lim] of Object.entries(classConcurrencyLimits)) {
        if (lim > globalConcurrencyLimit) fail(`classConcurrencyLimits.${c} exceeds globalConcurrencyLimit`);
    }

    const maxQueue = intInRange(raw.maxQueue ?? 256, 1, 100000, "maxQueue");
    const leaseTtlMs = intInRange(raw.leaseTtlMs ?? 300000, 1000, 86400000, "leaseTtlMs");
    const historyCapacity = intInRange(raw.historyCapacity ?? 512, 16, 65536, "historyCapacity");

    const memory = raw.memoryThresholds ?? {};
    const hostUsedMemoryRatio = orderedBands(
        memory.hostUsedMemoryRatio ?? { elevated: 0.6, high: 0.75, critical: 0.88 },
        "memoryThresholds.hostUsedMemoryRatio"
    );
    const processHeapUsedRatio = orderedBands(
        memory.processHeapUsedRatio ?? { elevated: 0.7, high: 0.82, critical: 0.92 },
        "memoryThresholds.processHeapUsedRatio"
    );
    numInRange(memory.hostHardFloorBytes ?? 256 * 1024 * 1024, 0, 1e15, "memoryThresholds.hostHardFloorBytes");

    const eventLoopLagMs = orderedBands(
        raw.eventLoopLagMs ?? { elevated: 100, high: 250, critical: 750 },
        "eventLoopLagMs"
    );

    const demandMaxima = raw.demandMaxima ?? {};
    const validatedDemandMaxima = {
        memoryBytesMax: intInRange(demandMaxima.memoryBytesMax ?? 2 * 1024 ** 3, 1, Number.MAX_SAFE_INTEGER, "demandMaxima.memoryBytesMax"),
        expectedDurationMsMax: intInRange(demandMaxima.expectedDurationMsMax ?? 3600000, 1, Number.MAX_SAFE_INTEGER, "demandMaxima.expectedDurationMsMax")
    };

    const aging = raw.aging ?? {};
    const validatedAging = {
        bonusPer10s: numInRange(aging.bonusPer10s ?? 5, 0, 100, "aging.bonusPer10s"),
        maxBonus: numInRange(aging.maxBonus ?? 120, 0, 400, "aging.maxBonus")
    };
    if (validatedAging.maxBonus < validatedAging.bonusPer10s) fail("aging.maxBonus must be >= aging.bonusPer10s");

    if (raw.unknownGroupPolicy !== undefined && raw.unknownGroupPolicy !== "reject") {
        fail('unknownGroupPolicy must be "reject" in V0');
    }

    return freezeDeep({
        globalConcurrencyLimit,
        groupLimits,
        classConcurrencyLimits,
        unknownGroupPolicy: "reject",
        maxQueue,
        leaseTtlMs,
        historyCapacity,
        memoryThresholds: { hostUsedMemoryRatio, processHeapUsedRatio, hostHardFloorBytes: memory.hostHardFloorBytes },
        eventLoopLagMs,
        demandMaxima: validatedDemandMaxima,
        aging: validatedAging
    });
}

function defaultResourceGovernorConfig(overrides) {
    return validateResourceGovernorConfig({ ...(overrides ?? {}) });
}

module.exports = { validateResourceGovernorConfig, defaultResourceGovernorConfig, KNOWN_GROUPS };
