"use strict";

const { BOUNDS, METER_SCHEMA_VERSION } = require("./bounds");

function makeMeters(store) {
    async function recordReading(kind, value, opts = {}) {
        if (typeof value !== "number") throw new Error("value must be a number");
        const readings = await store.getKv(`meter:${kind}`) || [];
        if (readings.length >= BOUNDS.MAX_METER_READINGS_PER_KIND) readings.shift();
        readings.push({ schemaVersion: METER_SCHEMA_VERSION, kind, value, recordedAt: Date.now(), source: opts.source || "system" });
        await store.putKv(`meter:${kind}`, readings);
        return readings[readings.length - 1];
    }

    async function writeReading(kind, value, opts = {}) {
        const src = opts && opts.source ? String(opts.source) : "system";
        if (src !== "system") {
            throw new Error(`Consumer cannot write meter readings directly — spoof refused (W9-L5)`);
        }
        return recordReading(kind, value, { source: src });
    }

    async function getReadings(kind) {
        return store.getKv(`meter:${kind}`) || [];
    }

    async function getSummary(kind) {
        const readings = await getReadings(kind);
        if (!readings.length) return { kind, count: 0, latest: null, avg: null };
        const values = readings.map(r => r.value);
        return {
            kind,
            count: values.length,
            latest: values[values.length - 1],
            avg: values.reduce((a, b) => a + b, 0) / values.length,
        };
    }

    return { recordReading, writeReading, getReadings, getSummary };
}

module.exports = { makeMeters };
