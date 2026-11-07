"use strict";

const { LedgerError, CODES } = require("./errors");

/**
 * Audit Ledger V1 — B1 input snapshot boundary.
 *
 * INVARIANT: storage must contain plain inert data only, and no property
 * may be validated using one value and stored using another.
 *
 * Strategy (single consistent boundary):
 *   The ENTIRE incoming event is snapshotted into plain inert data ONCE
 *   before ANY semantic validation runs. All later validation and
 *   storage read ONLY the snapshot. Therefore a getter/Proxy returning
 *   "valid" on read #1 and "malicious" on read #2 cannot split what is
 *   validated from what is stored.
 *
 * Snapshot rules (fail closed):
 *   - accessor own-properties (getter/setter) are REJECTED WITHOUT EVER
 *     INVOKING them — descriptors are inspected via
 *     Object.getOwnPropertyDescriptors, so caller code does not run;
 *   - functions, symbols, bigint, undefined values rejected;
 *   - non-plain object prototypes (class instances, Maps, Proxies that
 *     do not present as plain) rejected — but note: even if a Proxy
 *     spoofs a plain prototype, its FIRST-read values are copied into
 *     an inert plain snapshot, so nothing callable or live can survive;
 *   - cycles rejected; dangerous prototype keys rejected;
 *   - symbol-keyed properties rejected;
 *   - ONE GLOBAL traversal budget (B2) bounds total work across the
 *     whole snapshot; shared-reference DAG amplification hits the
 *     budget deterministically instead of exhausting memory.
 *
 * Depth: the event wrapper contributes two levels (event root +
 * metadata container), so snapshots allow bounds.maxMetadataDepth + 2.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Wrapper slack over the metadata depth bound. */
const SNAPSHOT_DEPTH_SLACK = 2;

function snapshotValue(value, budget, ancestors, depth, bounds) {
    budget.visited += 1;
    if (budget.visited > bounds.maxMetadataNodes) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `event input exceeds global node budget (${bounds.maxMetadataNodes})`);
    }

    if (value === null) return null;

    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            if (!Number.isFinite(value)) {
                throw new LedgerError(CODES.INVALID_EVENT,
                    `non-finite number in event input: ${value}`);
            }
            return value;
        case "bigint":
        case "symbol":
        case "function":
        case "undefined":
            throw new LedgerError(CODES.INVALID_EVENT,
                `unsupported value type in event input: ${typeof value}`);
        default:
            break;
    }

    if (depth > bounds.maxMetadataDepth + SNAPSHOT_DEPTH_SLACK) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `event nesting deeper than ${bounds.maxMetadataDepth + SNAPSHOT_DEPTH_SLACK}`);
    }

    const proto = Object.getPrototypeOf(value);

    if (Array.isArray(value)) {
        if (proto !== Array.prototype && proto !== null) {
            throw new LedgerError(CODES.INVALID_EVENT,
                "non-plain array in event input");
        }
        if (ancestors.has(value)) {
            throw new LedgerError(CODES.INVALID_EVENT, "cyclic event input");
        }
        if (value.length > bounds.maxMetadataArrayItems) {
            throw new LedgerError(CODES.BOUNDS_EXCEEDED,
                `event array exceeds ${bounds.maxMetadataArrayItems} items`);
        }
        ancestors.add(value);
        const out = value.map((item) =>
            snapshotValue(item, budget, ancestors, depth + 1, bounds));
        ancestors.delete(value);
        return out;
    }

    if (proto !== Object.prototype && proto !== null) {
        throw new LedgerError(CODES.INVALID_EVENT,
            "non-plain object in event input");
    }

    if (ancestors.has(value)) {
        throw new LedgerError(CODES.INVALID_EVENT, "cyclic event input");
    }

    // Single descriptor read per key: accessors are detected and
    // rejected WITHOUT invocation, so caller code never executes here.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > bounds.maxMetadataKeysPerLevel) {
        throw new LedgerError(CODES.BOUNDS_EXCEEDED,
            `event object exceeds ${bounds.maxMetadataKeysPerLevel} keys`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new LedgerError(CODES.INVALID_EVENT,
            "symbol-keyed properties are not allowed in event input");
    }

    const out = {};
    ancestors.add(value);
    for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key)) {
            throw new LedgerError(CODES.INVALID_EVENT,
                `forbidden object key in event input: "${key}"`);
        }
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) continue; // inert copy skips hidden state
        if (descriptor.get || descriptor.set) {
            throw new LedgerError(CODES.INVALID_EVENT,
                `accessor property not allowed in event input: "${key}"`);
        }
        // R1: at top level only, own property value===undefined => absent
        if (depth === 0 && descriptor.value === undefined) {
            continue; // omit this field from snapshot (treated as absent)
        }
        out[key] = snapshotValue(descriptor.value, budget, ancestors, depth + 1, bounds);
    }
    ancestors.delete(value);
    return out;
}

/**
 * Snapshot one append request into plain inert data.
 * @returns {{snapshot: object, budget: {visited: number}}}
 */
function snapshotEventInput(input, bounds) {
    const budget = { visited: 0 };
    const snapshot = snapshotValue(input, budget, new WeakSet(), 0, bounds);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new LedgerError(CODES.NOT_APPENDABLE, "event input must be an object");
    }
    return { snapshot, budget };
}

module.exports = Object.freeze({ snapshotEventInput, SNAPSHOT_DEPTH_SLACK });
