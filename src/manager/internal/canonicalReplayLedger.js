"use strict";

const fs = require("node:fs");
const path = require("node:path");

const STATES = Object.freeze({
    RESERVED: "RESERVED",
    INVOKING: "INVOKING",
    EXECUTED_UNVERIFIED: "EXECUTED_UNVERIFIED",
    COMPLETED_VERIFIED: "COMPLETED_VERIFIED",
    AMBIGUOUS: "AMBIGUOUS",
    CANCELLED_BEFORE_EFFECT: "CANCELLED_BEFORE_EFFECT",
    FAILED: "FAILED",
    UNVERIFIED: "UNVERIFIED"
});

function syncDirectory(directory) {
    if (process.platform === "win32") return;
    let fd;
    try {
        fd = fs.openSync(directory, "r");
        fs.fsyncSync(fd);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function appendDurably(file, record) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const fd = fs.openSync(file, "a");
    try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, "utf8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    syncDirectory(directory);
}

function readRecords(file) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const records = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { throw new Error("REPLAY_LEDGER_CORRUPT"); }
        if (!record || typeof record !== "object" || typeof record.digest !== "string" ||
            typeof record.state !== "string" || !Object.values(STATES).includes(record.state)) {
            throw new Error("REPLAY_LEDGER_CORRUPT");
        }
        records.push(record);
    }
    return records;
}

function createCanonicalReplayLedger({ file = path.join(process.cwd(), "data", "audit", "canonical-replay.jsonl"), now = () => Date.now() } = {}) {
    const latest = new Map();
    let loaded = false;
    function load() {
        if (loaded) return;
        for (const record of readRecords(file)) latest.set(record.digest, Object.freeze(record));
        loaded = true;
    }
    function append(digest, state, binding = {}) {
        const record = Object.freeze({
            atMs: now(), digest, state,
            capabilityId: binding.capabilityId ?? null,
            operation: binding.operation ?? null,
            principal: binding.principal ?? null,
            scope: binding.scope ?? null,
            authorityGeneration: binding.authorityGeneration ?? null,
            driverId: binding.driverId ?? null
        });
        appendDurably(file, record);
        latest.set(digest, record);
        return record;
    }
    function sameBinding(a, b) {
        return a.capabilityId === b.capabilityId && a.operation === b.operation &&
            a.principal === b.principal && JSON.stringify(a.scope ?? null) === JSON.stringify(b.scope ?? null) &&
            a.authorityGeneration === b.authorityGeneration && a.driverId === b.driverId;
    }
    return Object.freeze({
        reserve(binding = {}) {
            load();
            const prior = latest.get(binding.digest);
            if (prior) {
                if (!sameBinding(prior, binding)) throw new Error("REPLAY_LEDGER_BINDING_MISMATCH");
                return { reserved: false, prior };
            }
            return { reserved: true, record: append(binding.digest, STATES.RESERVED, binding) };
        },
        transition(digest, state, binding = {}) {
            load();
            if (!latest.has(digest)) throw new Error("REPLAY_LEDGER_MISSING_RESERVATION");
            return append(digest, state, binding);
        },
        lookup(digest) { load(); return latest.get(digest) ?? null; },
        filePath: file,
        STATES
    });
}

module.exports = { STATES, createCanonicalReplayLedger };
