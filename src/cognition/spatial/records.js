"use strict";

/**
 * W8-L3 record builders. Follows the same trap-safe discipline established
 * across every Wave7 lane (worldmodel/prospective/etc., see this session's
 * audit history): descriptor-based reads only, DANGEROUS_KEYS rejected
 * explicitly, non-finite numbers/functions/symbols/BigInt rejected,
 * bounded depth/node count, sanitize BEFORE any truncation.
 */

const { REASONS, fail } = require("./errors");
const { BOUNDS } = require("./bounds");

const FRAME_KINDS = new Set(["SCREEN", "ROOM", "GEO", "BODY", "LOGICAL"]);
const OCCUPANCY_STATES = new Set(["KNOWN", "UNKNOWN", "CONTESTED"]);
const DANGEROUS_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_NODES = 512;

function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
}

/**
 * Trap-safe opaque-payload sanitizer for transform/region data -- mirrors
 * worldmodel's buildSafePayloadRef/buildSafeBeliefValue shape exactly
 * (descriptor reads only, reject accessor properties, reject
 * function/symbol/bigint/non-finite number, reject DANGEROUS_KEYS,
 * bounded depth and node count via a shared budget object).
 */
function buildSafeSpatialValue(value, depth = 0, budget) {
    if (!budget) budget = { count: 0 };
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === "function") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh membawa fungsi");
    if (t === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh membawa Symbol");
    if (t === "bigint") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh membawa BigInt");
    if (t === "number" && !Number.isFinite(value)) {
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh berupa angka non-finite");
    }
    if (t !== "object") return value;
    if (depth > MAX_SCAN_DEPTH) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial terlalu dalam untuk diverifikasi dengan aman");
    budget.count += 1;
    if (budget.count > MAX_SCAN_NODES) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "jumlah node pada nilai spasial melebihi batas");

    try {
        if (Array.isArray(value)) {
            const len = value.length;
            if (!Number.isInteger(len) || len < 0) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array tidak sah");
            const out = [];
            for (let i = 0; i < len; i++) {
                const desc = Object.getOwnPropertyDescriptor(value, i);
                if (!desc || desc.get || desc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `elemen array pada indeks '${i}' tidak boleh membawa properti accessor`);
                out.push(buildSafeSpatialValue(desc.value, depth + 1, budget));
            }
            return out;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh berupa instance kelas");
        }
        const out = {};
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh membawa kunci Symbol");
            if (DANGEROUS_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak: '${key}'`);
            const desc = Object.getOwnPropertyDescriptor(value, key);
            if (!desc || desc.get || desc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `nilai spasial tidak boleh membawa properti accessor: '${key}'`);
            out[key] = buildSafeSpatialValue(desc.value, depth + 1, budget);
        }
        return out;
    } catch (err) {
        let isDomainError = false;
        try {
            const { SpatialError } = require("./errors");
            isDomainError = err instanceof SpatialError;
        } catch {
            isDomainError = false;
        }
        if (isDomainError) throw err;
        fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak dapat diverifikasi dengan aman");
    }
}

function makeFrame({ frameId, kind, ref, source, nowMs }, bounds = BOUNDS) {
    if (typeof frameId !== "string" || !frameId) fail(REASONS.INVALID_RECORD, "frameId wajib string");
    if (!FRAME_KINDS.has(kind)) fail(REASONS.INVALID_RECORD, `frame kind '${typeof kind === "string" ? kind : typeof kind}' tidak dikenal`);
    if (typeof source !== "string" || !source) fail(REASONS.INVALID_RECORD, "source wajib string");
    const safeRef = buildSafeSpatialValue(ref);
    return Object.freeze({
        frameId, kind, ref: deepFreeze(safeRef), source,
        registeredAt: nowMs
    });
}

function makeTransform({ transformId, fromFrameId, toFrameId, data, nowMs }, bounds = BOUNDS) {
    if (typeof transformId !== "string" || !transformId) fail(REASONS.INVALID_RECORD, "transformId wajib string");
    if (typeof fromFrameId !== "string" || !fromFrameId) fail(REASONS.INVALID_RECORD, "fromFrameId wajib string");
    if (typeof toFrameId !== "string" || !toFrameId) fail(REASONS.INVALID_RECORD, "toFrameId wajib string");
    if (fromFrameId === toFrameId) fail(REASONS.TRANSFORM_CYCLE_REJECTED, "transform tidak boleh menghubungkan frame dengan dirinya sendiri");
    const safeData = buildSafeSpatialValue(data);
    return Object.freeze({
        transformId, fromFrameId, toFrameId, data: deepFreeze(safeData),
        registeredAt: nowMs
    });
}

function makeSceneNode({ nodeId, frameId, region, state, observationRefs, updatedAtMs }, bounds = BOUNDS) {
    if (typeof nodeId !== "string" || !nodeId) fail(REASONS.INVALID_RECORD, "nodeId wajib string");
    if (typeof frameId !== "string" || !frameId) fail(REASONS.INVALID_RECORD, "frameId wajib string");
    if (!OCCUPANCY_STATES.has(state)) fail(REASONS.INVALID_RECORD, `scene node state '${typeof state === "string" ? state : typeof state}' tidak dikenal`);
    const safeRegion = buildSafeSpatialValue(region);
    let refs;
    try {
        refs = Array.isArray(observationRefs) ? observationRefs.map(r => {
            if (typeof r !== "string" || !r) fail(REASONS.INVALID_RECORD, "observationRefs elemen wajib string");
            return r;
        }) : [];
    } catch (err) {
        if (err && err.name === "SpatialError") throw err;
        fail(REASONS.INVALID_RECORD, "observationRefs tidak dapat diverifikasi dengan aman");
    }
    return Object.freeze({
        nodeId, frameId, region: deepFreeze(safeRegion), state,
        observationRefs: Object.freeze(refs), updatedAtMs
    });
}

module.exports = {
    FRAME_KINDS, OCCUPANCY_STATES, buildSafeSpatialValue, deepFreeze,
    makeFrame, makeTransform, makeSceneNode
};
