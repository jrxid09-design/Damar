/**
 * W8-L1 modality reconciliation (frozen contract, "Source/device/node
 * identity semantics"): maps `classifyCapability`'s open-ended domain
 * output onto the CLOSED enum W7-L2 world-model observations carry.
 * This table belongs to the bridge, not to `classifyCapability` itself —
 * `classifyCapability`'s own open-ended domain semantics stay undisturbed
 * for every other existing caller.
 */

"use strict";

const SENSOR_MODALITIES = Object.freeze([
    "VISION", "AUDIO", "TEXT", "SCREEN", "RF", "IMU", "TEMP", "POWER",
    "NETWORK", "FS", "OTHER"
].reduce((m, v) => (m[v] = v, m), {}));

/** `classifyCapability(...).modality` -> closed W8-L1 SENSOR_MODALITIES value. */
const MODALITY_MAP = Object.freeze({
    vision: SENSOR_MODALITIES.VISION,
    audio: SENSOR_MODALITIES.AUDIO,
    display: SENSOR_MODALITIES.SCREEN,
    network: SENSOR_MODALITIES.NETWORK,
    storage: SENSOR_MODALITIES.FS
    // hid/telemetry/generic/anything else: OTHER (see toSensorModality below).
});

function toSensorModality(rawModality) {
    return MODALITY_MAP[rawModality] ?? SENSOR_MODALITIES.OTHER;
}

module.exports = { SENSOR_MODALITIES, MODALITY_MAP, toSensorModality };
