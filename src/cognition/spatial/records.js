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

/**
 * Bug review independen (audit round 1, Codex, AUDL3-P1-4): every public
 * entry point destructured its `spec` object RAW (`{ frameId, kind, ... } =
 * spec || {}`), an ordinary [[Get]] that executes any accessor getter on
 * ANY requested field before this lane could ever sanitize it -- the exact
 * class that dominated the Wave7 audit history (this session's own
 * MILESTONE_LEDGER.md, rounds 41-73). Reads the requested `fields` from
 * `spec` via property descriptor, rejecting accessors outright, and never
 * invokes any getter. `spec` itself may be null/undefined (returns an
 * all-undefined copy, matching every other Wave7 lane's "explicit null is
 * not a crash" convention) or a revoked Proxy (fails closed as
 * INVALID_RECORD, not a raw TypeError).
 */
function readSpecFields(spec, fields) {
    if (spec === null || spec === undefined) {
        const empty = {};
        for (const f of fields) empty[f] = undefined;
        return empty;
    }
    if (typeof spec !== "object") fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
    let keys;
    try {
        keys = new Set(Object.keys(spec));
    } catch {
        fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
    }
    const out = {};
    for (const f of fields) {
        if (!keys.has(f)) { out[f] = undefined; continue; }
        let desc;
        try {
            desc = Object.getOwnPropertyDescriptor(spec, f);
        } catch {
            fail(REASONS.INVALID_RECORD, "spec tidak dapat diverifikasi dengan aman, ditolak");
        }
        if (!desc || desc.get || desc.set) {
            fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `spec tidak boleh membawa properti accessor: '${f}'`);
        }
        out[f] = desc.value;
    }
    return out;
}

/** frameId/toFrameId/etc. must be validated as strings BEFORE reaching any
 * template-literal key derivation (sceneNodeKey/regionKey/error messages) --
 * a Symbol interpolated into a template literal raw-throws TypeError before
 * any domain-error guard runs (AUDL3-P1-4's second half). */
function requireStringId(value, fieldName) {
    if (typeof value !== "string" || !value) {
        fail(REASONS.INVALID_RECORD, `${fieldName} wajib string tidak kosong`);
    }
    return value;
}
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
            const lengthDesc = Object.getOwnPropertyDescriptor(value, "length");
            if (!lengthDesc || !("value" in lengthDesc)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array tidak dapat diverifikasi dengan aman");
            const len = lengthDesc.value;
            if (!Number.isInteger(len) || len < 0) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "panjang array tidak sah");
            const out = [];
            for (let i = 0; i < len; i++) {
                const desc = Object.getOwnPropertyDescriptor(value, i);
                if (!desc || desc.get || desc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `elemen array pada indeks '${i}' tidak boleh membawa properti accessor`);
                out.push(buildSafeSpatialValue(desc.value, depth + 1, budget));
            }
            // Bug review independen (audit round 2, Codex, AUDL3-P2-2): cabang
            // array di atas hanya memvalidasi indeks numerik -- properti OWN
            // NON-indeks (mis. `toJSON` fungsi, atau kunci berbahaya) tidak
            // pernah divalidasi sama sekali, membiarkan materi eksekusi lolos
            // dan (via canonicalRegionKey) dua region yang SECARA SEMANTIK
            // berbeda collapse jadi kunci yang sama. Sibling PERSIS dari
            // worldmodel's buildSafeArray fix (putaran-67 audit Wave7) --
            // properti non-indeks divalidasi (ditolak kalau berbahaya) walau
            // tidak pernah disalin ke `out`.
            const ARRAY_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
            for (const key of Reflect.ownKeys(value)) {
                if (key === "length" || (typeof key === "string" && ARRAY_INDEX_PATTERN.test(key) && Number(key) < len)) continue;
                if (typeof key === "symbol") fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, "nilai spasial tidak boleh membawa kunci Symbol pada array");
                if (DANGEROUS_KEYS.includes(key)) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `kunci berbahaya ditolak pada array: '${key}'`);
                const extraDesc = Object.getOwnPropertyDescriptor(value, key);
                if (!extraDesc || extraDesc.get || extraDesc.set) fail(REASONS.EXECUTABLE_MATERIAL_REJECTED, `properti array '${key}' tidak boleh membawa properti accessor`);
                buildSafeSpatialValue(extraDesc.value, depth + 1, budget); // divalidasi, tidak disalin -- sama seperti worldmodel's buildSafeArray
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
        refs = Array.isArray(observationRefs) ? buildSafeSpatialValue(observationRefs).map(r => {
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

/**
 * Bug review independen (audit round 1, Codex, AUDL3-P1-3): raw
 * JSON.stringify for region identity depends on caller-controlled object
 * key insertion order (two logically-identical regions with different key
 * order produce different keys, splitting one region into two and hiding a
 * genuine disagreement from CONTESTED_GEOMETRY_BLOCKS_MOTION) and on
 * caller-controlled toJSON (which JSON.stringify invokes as caller code).
 * Called only on the ALREADY-SANITIZED output of buildSafeSpatialValue
 * (never the raw caller region), so there is no toJSON/accessor/prototype
 * to invoke by the time this runs; keys are additionally sorted here so
 * insertion order can never affect the derived key.
 */
function canonicalStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",")}}`;
}

/** Sanitize THEN canonicalize -- the only safe order (sanitize before truncate/key-derive, this session's own audit lesson from round 67). */
function canonicalRegionKey(region) {
    const safe = buildSafeSpatialValue(region);
    return canonicalStringify(safe ?? null);
}

module.exports = {
    FRAME_KINDS, OCCUPANCY_STATES, buildSafeSpatialValue, deepFreeze,
    makeFrame, makeTransform, makeSceneNode,
    readSpecFields, requireStringId, canonicalRegionKey
};
