"use strict";

/**
 * EXTENSION KERNEL V1 — minimal strict semantic versioning.
 *
 * Only what dependency compatibility needs: strict `MAJOR.MINOR.PATCH[-pre]`
 * parsing, total ordering, and a small range language:
 *
 *   "1.2.3"      exact
 *   "*"          any
 *   "^1.2.3"     >=1.2.3 <2.0.0        (^0.2.3 -> >=0.2.3 <0.3.0)
 *   "~1.2.3"     >=1.2.3 <1.3.0
 *
 * Anything malformed fails closed (INVALID_VERSION / INVALID_VERSION_RANGE).
 */

const { fail, REASONS } = require("./errors");

const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+(?:\.[0-9A-Za-z.-]+)*))?$/;
const MAX_NUMERIC = 999999;

function parseVersion(raw) {
    if (typeof raw !== "string") {
        throw fail(REASONS.INVALID_VERSION, `version must be string, got ${typeof raw}`);
    }
    const m = VERSION_RE.exec(raw.trim());
    if (!m) {
        throw fail(REASONS.INVALID_VERSION, `malformed semantic version: '${raw.slice(0, 64)}'`,
            { received: raw.slice(0, 64) });
    }
    const prerelease = m[4] ? Object.freeze(m[4].split(".")) : Object.freeze([]);
    return deepFreeze({
        major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
        prerelease, raw: raw.trim()
    });
}

function comparePrerelease(a, b) {
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;   // release > prerelease
    if (b.length === 0) return -1;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const av = a[i], bv = b[i];
        if (av === undefined) return -1;
        if (bv === undefined) return 1;
        const an = /^[0-9]+$/.test(av), bn = /^[0-9]+$/.test(bv);
        if (an && bn) {
            const d = Number(av) - Number(bv);
            if (d !== 0) return d < 0 ? -1 : 1;
        } else if (an !== bn) {
            return an ? -1 : 1;     // numeric < alphanumeric
        } else if (av !== bv) {
            return av < bv ? -1 : 1;
        }
    }
    return 0;
}

function compareVersions(a, b) {
    for (const k of ["major", "minor", "patch"]) {
        if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
    }
    return comparePrerelease(a.prerelease, b.prerelease);
}

function satisfiesRange(version, rangeRaw) {
    if (typeof rangeRaw !== "string" || rangeRaw.length > 64) {
        throw fail(REASONS.INVALID_VERSION_RANGE, "version range must be a short string");
    }
    const range = rangeRaw.trim();
    if (range === "" || range === "*") return true;

    let op = "=";
    let rest = range;
    if (range.startsWith("^") || range.startsWith("~")) {
        op = range[0];
        rest = range.slice(1).trim();
    } else if (range.startsWith("=")) {
        rest = range.slice(1).trim();
    }
    const base = parseVersion(rest); // throws INVALID_VERSION on garbage
    if (base.major > MAX_NUMERIC || base.minor > MAX_NUMERIC || base.patch > MAX_NUMERIC) {
        throw fail(REASONS.INVALID_VERSION_RANGE, "version components out of supported magnitude");
    }

    const cmp = compareVersions(version, base);
    if (op === "=" || op === "") return cmp === 0;
    if (cmp < 0) return false;

    if (op === "^") {
        const upper = base.major > 0
            ? { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
            : base.minor > 0
                ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
                : { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
        return compareVersions(version, upper) < 0;
    }
    // "~"
    const upper = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
    return compareVersions(version, upper) < 0;
}

function deepFreeze(obj) {
    if (obj !== null && typeof obj === "object") {
        for (const key of Object.getOwnPropertyNames(obj)) {
            deepFreeze(obj[key]);
        }
        Object.freeze(obj);
    }
    return obj;
}

module.exports = { parseVersion, compareVersions, satisfiesRange };
