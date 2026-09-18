"use strict";

/**
 * Audit Ledger V1 — deterministic canonical JSON serialization.
 *
 * Self-contained copy of the repository-canonical rules (same semantics
 * as the Recovery capsule serializer) so that the ledger has NO import
 * edge into any other subsystem — a structural property the ledger's
 * own audit test enforces.
 *
 * Same semantic value => same canonical bytes => same digest.
 * Fail-closed: sorted keys, NaN/Infinity/BigInt/undefined/function/symbol
 * rejected, cycles rejected, non-plain objects rejected, dangerous
 * prototype keys (__proto__, constructor, prototype) rejected.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const IS_PROXY = require("node:util").types.isProxy;

/**
 * `JSON.stringify` DIBEKUKAN SAAT MODUL DIMUAT.
 *
 * Serializer ini menghasilkan byte yang menentukan digest dan isi jurnal audit.
 * `JSON.stringify` yang ditimpa pasca-pemuatan cukup untuk membuat transisi
 * governed "berhasil" sementara isi disk bukan JSON yang sah -- restart
 * melaporkan `corrupt:true, records:0` (audit 64a999b). Dipanggil lewat binding
 * lokal, bukan pencarian properti pada `JSON` yang masih dapat dijangkau.
 */
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_NAMES = Object.getOwnPropertyNames;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_IS = Object.is;
const ARRAY_IS_ARRAY = Array.isArray;
const WEAKSET = WeakSet;
const STRINGIFY_REFLECT_APPLY = Reflect.apply;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SORT = Array.prototype.sort;
const SET_HAS = Set.prototype.has;
const WEAKSET_HAS = WeakSet.prototype.has;
const WEAKSET_ADD = WeakSet.prototype.add;
const WEAKSET_DELETE = WeakSet.prototype.delete;

function applyIntrinsic(fn, receiver, args) {
    return STRINGIFY_REFLECT_APPLY(fn, receiver, args);
}

function stringify(value) {
    return STRINGIFY_REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
}

class CanonicalizationError extends Error {
    constructor(message) {
        super(message);
        this.name = "CanonicalizationError";
        this.code = "E_CANONICALIZATION";
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const proto = OBJECT_GET_PROTOTYPE_OF(value);
    return proto === OBJECT_PROTOTYPE || proto === null;
}

function canonicalizeValue(value, ancestors, depth, maxDepth) {
    if (depth > maxDepth) {
        throw new CanonicalizationError("maximum nesting depth exceeded");
    }
    switch (typeof value) {
        case "string":
            return stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!NUMBER_IS_FINITE(value)) {
                throw new CanonicalizationError(`non-finite number: ${value}`);
            }
            if (OBJECT_IS(value, -0)) return "0";
            return stringify(value);
        case "bigint":
        case "undefined":
        case "function":
        case "symbol":
            throw new CanonicalizationError(`unsupported value type: ${typeof value}`);
        default:
            break;
    }

    if (value === null) return "null";
    if (IS_PROXY(value)) {
        throw new CanonicalizationError("Proxy values are unsupported");
    }

    if (ARRAY_IS_ARRAY(value)) {
        if (applyIntrinsic(WEAKSET_HAS, ancestors, [value])) {
            throw new CanonicalizationError("circular reference detected");
        }
        applyIntrinsic(WEAKSET_ADD, ancestors, [value]);
        const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "length");
        const parts = [];
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
            const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "" + index);
            if (!descriptor || descriptor.get || descriptor.set) {
                throw new CanonicalizationError("sparse arrays and accessor elements are unsupported");
            }
            parts[parts.length] = canonicalizeValue(descriptor.value, ancestors, depth + 1, maxDepth);
        }
        applyIntrinsic(WEAKSET_DELETE, ancestors, [value]);
        return `[${applyIntrinsic(ARRAY_JOIN, parts, [","])}]`;
    }

    if (!isPlainObject(value)) {
        throw new CanonicalizationError("non-plain object");
    }

    if (applyIntrinsic(WEAKSET_HAS, ancestors, [value])) {
        throw new CanonicalizationError("circular reference detected");
    }
    applyIntrinsic(WEAKSET_ADD, ancestors, [value]);

    const names = applyIntrinsic(ARRAY_SORT, OBJECT_GET_OWN_PROPERTY_NAMES(value), []);
    const parts = [];
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        const name = names[nameIndex];
        if (applyIntrinsic(SET_HAS, FORBIDDEN_KEYS, [name])) {
            throw new CanonicalizationError(`forbidden object key: "${name}"`);
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, name);
        if (!descriptor || descriptor.get || descriptor.set) {
            throw new CanonicalizationError(`accessor object key is unsupported: "${name}"`);
        }
        const raw = descriptor.value;
        if (raw === undefined) {
            throw new CanonicalizationError(`undefined value for key "${name}"`);
        }
        parts[parts.length] = `${stringify(name)}:${canonicalizeValue(raw, ancestors, depth + 1, maxDepth)}`;
    }

    applyIntrinsic(WEAKSET_DELETE, ancestors, [value]);
    return `{${applyIntrinsic(ARRAY_JOIN, parts, [","])}}`;
}

/** Serialize to canonical JSON string. */
function canonicalJson(value, options = {}) {
    let maxDepth = 16;
    if (options !== null && options !== undefined) {
        if (typeof options !== "object" || IS_PROXY(options)) {
            throw new CanonicalizationError("canonicalization options are unsupported");
        }
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(options, "maxDepth");
        if (descriptor && (descriptor.get || descriptor.set)) {
            throw new CanonicalizationError("maxDepth option must be a data property");
        }
        if (descriptor && descriptor.value !== undefined) maxDepth = descriptor.value;
    }
    if (!NUMBER_IS_SAFE_INTEGER(maxDepth) || maxDepth < 0) {
        throw new CanonicalizationError("maxDepth must be a non-negative safe integer");
    }
    return canonicalizeValue(value, new WEAKSET(), 0, maxDepth);
}

module.exports = Object.freeze({ CanonicalizationError, canonicalJson });
