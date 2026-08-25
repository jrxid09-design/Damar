"use strict";

const BRAND = Symbol("aether.resourceGovernor.workloadIdBrand");
const ID_PATTERN = /^[a-z][a-z0-9]{0,49}(-[a-z0-9]{1,50}){0,7}$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 64;

function isWhitespaceContaminated(raw) {
    if (typeof raw !== "string") return true;
    for (const ch of raw) {
        if (/\s/.test(ch) || ch === "\u00a0" || ch === "\ufeff") return true;
    }
    return false;
}

function canonicalizeWorkloadId(raw) {
    if (typeof raw !== "string") {
        throw new TypeError("workload id must be a string");
    }
    if (isWhitespaceContaminated(raw)) {
        throw new Error("INVALID_WORKLOAD_ID: whitespace not permitted");
    }
    if (raw.length < MIN_LENGTH || raw.length > MAX_LENGTH) {
        throw new Error("INVALID_WORKLOAD_ID: length out of range");
    }
    if (!ID_PATTERN.test(raw) || raw.includes("--")) {
        throw new Error(`INVALID_WORKLOAD_ID: ${JSON.stringify(raw)} violates canonical grammar`);
    }
    return raw;
}

function createWorkloadId(raw) {
    const value = canonicalizeWorkloadId(raw);
    return Object.freeze({
        [BRAND]: true,
        kind: "WorkloadId",
        value,
        toString() { return value; },
        equals(other) {
            return other !== null && typeof other === "object" &&
                other.kind === "WorkloadId" && other.value === value;
        }
    });
}

function workloadIdToString(id) {
    if (id === null || typeof id !== "object" || id.kind !== "WorkloadId" ||
        id[BRAND] !== true || typeof id.value !== "string" || !ID_PATTERN.test(id.value)) {
        throw new Error("INVALID_WORKLOAD_ID: not an authentic canonical WorkloadId");
    }
    return id.value;
}

function newWorkloadId(base, { seq = 0, entropy = "" } = {}) {
    let stem = String(base)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/--+/g, "-") || "wl";
    const tail = `${seq.toString(36)}${String(entropy).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8) || "0"}`;
    stem = stem.slice(0, Math.min(MAX_LENGTH - tail.length - 1, 40)).replace(/-+$/g, "");
    return createWorkloadId(`${stem}-${tail}`);
}

module.exports = { createWorkloadId, workloadIdToString, canonicalizeWorkloadId, newWorkloadId };
