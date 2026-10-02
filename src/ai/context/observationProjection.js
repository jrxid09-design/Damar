"use strict";

const ContextItem = require("./ContextItem");

// This module is deliberately a read-only adapter.  It owns no observation
// state: BodySchema and domain services remain the owners of their records.
const DEFAULT_MAX_ITEMS = 32;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function safeNow(clock) {
    try {
        const value = clock && typeof clock.nowMs === "function" ? clock.nowMs() : Date.now();
        return Number.isFinite(value) ? value : Date.now();
    } catch { return Date.now(); }
}

function freshness(observedAt, now, maxAgeMs, invalidated = false) {
    if (invalidated) return { state: "stale", observedAt, invalidated: true };
    if (!Number.isFinite(observedAt)) return { state: "unknown" };
    return {
        state: now - observedAt > maxAgeMs ? "stale" : "known",
        observedAt,
        expiresAt: observedAt + maxAgeMs,
        invalidated: false
    };
}

function bodyItems(body, { now, maxAgeMs }) {
    if (!body || typeof body.listDevices !== "function") return [];
    const items = [];
    for (const device of body.listDevices()) {
        const descriptor = device.descriptor ?? {};
        const state = descriptor.state ?? "unknown";
        const id = descriptor.deviceId ?? "unknown-device";
        const observedAt = device.presence?.observedAtMs ?? device.health?.checkedAt ?? null;
        items.push(ContextItem.create({
            source: "body-schema",
            kind: ContextItem.KIND.TOOL_OBSERVATION,
            content: `device ${id} state=${state} class=${descriptor.deviceClass ?? "unknown"}`,
            priority: 70,
            provenance: `body-schema:${id}`,
            freshness: freshness(observedAt, now, maxAgeMs),
            fact: { key: `device.${id}.state`, value: state, source: "body-schema", observedAt },
            metadata: { observationType: "device_state", deviceId: id, source: "BodySchema" }
        }));

        for (const channel of body.sensorChannels?.() ?? []) {
            if (!channel.deviceIds?.includes(id)) continue;
            const records = body.getChannelObservations?.(channel.channelId) ?? [];
            const record = [...records].reverse().find(r => r.deviceId === id);
            if (!record) continue;
            const invalidated = record.healthState === "FAILED";
            const f = freshness(record.atMs, now, maxAgeMs, invalidated);
            const value = record.healthState === "FAILED" ? null : record.sample;
            items.push(ContextItem.create({
                source: "sensorium",
                kind: ContextItem.KIND.TOOL_OBSERVATION,
                content: `sensor ${id}/${record.channelId} sample=${JSON.stringify(value).slice(0, 700)}`,
                priority: 65,
                provenance: `sensorium:${record.source}:${record.channelId}`,
                freshness: f,
                fact: { key: `sensor.${id}.${record.channelId}`, value, source: "sensorium", observedAt: record.atMs },
                metadata: {
                    observationType: "sensor_observation",
                    deviceId: id,
                    channelId: record.channelId,
                    source: record.source,
                    confidence: record.confidence,
                    sequence: record.atMs
                }
            }));
        }
    }
    return items;
}

function mataDewaItems(service, { now, maxAgeMs }) {
    if (!service || !(service.observations instanceof Map)) return [];
    return [...service.observations.values()].map(obs => {
        const value = obs.attributes ?? { type: obs.type };
        return ContextItem.create({
            source: "mata-dewa",
            kind: ContextItem.KIND.TOOL_OBSERVATION,
            content: `spatial ${obs.type ?? "observation"} source=${obs.source ?? "unknown"} id=${obs.id ?? "unknown"}`,
            priority: 55,
            provenance: `mata-dewa:${obs.source ?? "unknown"}:${obs.id ?? "unknown"}`,
            freshness: freshness(obs.observedAt, now, maxAgeMs),
            fact: { key: `spatial.${obs.id ?? "unknown"}`, value, source: "mata-dewa", observedAt: obs.observedAt },
            metadata: { observationType: "spatial_observation", source: obs.source, observationId: obs.id, confidence: obs.confidence }
        });
    });
}

function createObservationProjection({ body = null, mataDewa = null, clock = null,
    maxItems = DEFAULT_MAX_ITEMS, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 256) {
        throw new TypeError("maxItems must be an integer between 1 and 256");
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError("maxAgeMs must be non-negative");

    function read() {
        const now = safeNow(clock);
        return Object.freeze([
            ...bodyItems(body, { now, maxAgeMs }),
            ...mataDewaItems(mataDewa, { now, maxAgeMs })
        ].slice(0, maxItems));
    }

    return Object.freeze({
        read,
        toContextItems: read,
        dispose() { return Object.freeze({ disposed: true }); }
    });
}

module.exports = { createObservationProjection, DEFAULT_MAX_ITEMS, DEFAULT_MAX_AGE_MS };
