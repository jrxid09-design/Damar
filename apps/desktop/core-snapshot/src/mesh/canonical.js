"use strict";

/**
 * WAVE 6 MESH — deterministic canonical serialization (L1).
 *
 * Security-relevant digests (envelope payloadDigest, authenticity proof,
 * trust record digests) are computed ONLY over this deterministic encoding:
 * key order = sorted code-unit, arrays preserve order, no whitespace,
 * -0 normalized to 0, NaN/Infinity/BigInt/undefined/functions/symbols/
 * circulars rejected. Same discipline as the frozen audit ledger.
 */

function canonicalize(value) {
    const seen = new WeakSet();

    function walk(v) {
        if (v === null) return null;
        const t = typeof v;
        if (t === "string") return v;
        if (t === "boolean") return v;
        if (t === "number") {
            if (!Number.isFinite(v)) throw new TypeError("canonicalize: non-finite number");
            return Object.is(v, -0) ? 0 : v;
        }
        if (t === "bigint") throw new TypeError("canonicalize: bigint not allowed");
        if (t === "undefined") throw new TypeError("canonicalize: undefined not allowed");
        if (t === "function" || t === "symbol") throw new TypeError("canonicalize: functions/symbols not allowed");
 if (Array.isArray(v)) {
 if (seen.has(v)) throw new TypeError("canonicalize: circular array");
 seen.add(v);
 try {
 for (const item of v) {
 if (item === undefined) throw new TypeError("canonicalize: undefined array element");
 walk(item);
 }
 return v.map(walk);
 } finally { seen.delete(v); }
 }
        if (t !== "object") throw new TypeError(`canonicalize: unsupported type ${t}`);
        if (seen.has(v)) throw new TypeError("canonicalize: circular object");
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalize: non-plain object");
        seen.add(v);
        try {
            const out = {};
            for (const k of Object.keys(v).sort()) {
                const dv = v[k];
                if (dv === undefined) continue; // undefined values omitted deterministically
                out[k] = walk(dv);
            }
            return out;
        } finally { seen.delete(v); }
    }

    return walk(value);
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function canonicalBytes(value) {
    return Buffer.from(canonicalJson(value), "utf8");
}

function sha256Hex(value) {
    return require("node:crypto").createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

module.exports = Object.freeze({ canonicalize, canonicalJson, canonicalBytes, sha256Hex });
