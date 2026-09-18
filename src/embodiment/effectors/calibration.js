"use strict";

const { types } = require("node:util");
const isProxy = types.isProxy.bind(types);

function validateCalibration(record, { nowMs = Date.now() } = {}) {
    if (!record || typeof record !== "object" || isProxy(record)) throw new TypeError("invalid calibration record");
    const proto = Object.getPrototypeOf(record);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("calibration must be a plain record");
    const values = Object.create(null);
    for (const key of ["calibrationRef", "appliedAt", "validUntil", "offsets", "scale"]) {
        const d = Object.getOwnPropertyDescriptor(record, key);
        if (d && !Object.prototype.hasOwnProperty.call(d, "value")) throw new TypeError("calibration accessors are not accepted");
        values[key] = d && d.value;
    }
    if (typeof values.calibrationRef !== "string" || !values.calibrationRef ||
        !Number.isFinite(values.appliedAt) || !Number.isFinite(values.validUntil) ||
        !Number.isFinite(nowMs) || values.validUntil <= nowMs || values.appliedAt > nowMs ||
        !values.offsets || typeof values.offsets !== "object" || isProxy(values.offsets) ||
        !values.scale || typeof values.scale !== "object" || isProxy(values.scale)) {
        throw new TypeError("invalid or expired calibration record");
    }
    const copyVector = (input, name) => {
        const vectorProto = Object.getPrototypeOf(input);
        if (vectorProto !== Object.prototype && vectorProto !== null) throw new TypeError(`invalid ${name}`);
        const output = Object.create(null);
        for (const key of Reflect.ownKeys(input)) {
            if (typeof key !== "string") throw new TypeError(`invalid ${name}`);
            const d = Object.getOwnPropertyDescriptor(input, key);
            if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || typeof d.value !== "number" || !Number.isFinite(d.value)) {
                throw new TypeError(`invalid ${name}`);
            }
            output[key] = d.value;
        }
        return Object.freeze(output);
    };
    return Object.freeze({
        calibrationRef: values.calibrationRef,
        appliedAt: values.appliedAt,
        validUntil: values.validUntil,
        offsets: copyVector(values.offsets, "offsets"),
        scale: copyVector(values.scale, "scale")
    });
}

function applyCalibration(sample, calibration, { nowMs = Date.now() } = {}) {
    const cleanCalibration = validateCalibration(calibration, { nowMs });
    if (!sample || typeof sample !== "object" || isProxy(sample) || Array.isArray(sample)) {
        throw new TypeError("sample must be a plain data record");
    }
    const proto = Object.getPrototypeOf(sample);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("sample must be a plain data record");
    const out = Object.create(null);
    for (const key of Reflect.ownKeys(sample)) {
        if (typeof key !== "string") throw new TypeError("sample symbol keys are not allowed");
        const d = Object.getOwnPropertyDescriptor(sample, key);
        if (!d || !Object.prototype.hasOwnProperty.call(d, "value") || typeof d.value !== "number" || !Number.isFinite(d.value)) {
            throw new TypeError("sample values must be finite data numbers");
        }
        const scale = cleanCalibration.scale[key] === undefined ? 1 : cleanCalibration.scale[key];
        const offset = cleanCalibration.offsets[key] === undefined ? 0 : cleanCalibration.offsets[key];
        const value = d.value * scale + offset;
        if (!Number.isFinite(value)) throw new TypeError("calibrated value is not finite");
        out[key] = value;
    }
    return Object.freeze(out);
}

function auditCalibrationChange(appendAuditSync, effectorId, calibrationRef, atMs) {
    if (typeof appendAuditSync !== "function" || typeof effectorId !== "string" ||
        typeof calibrationRef !== "string" || !Number.isFinite(atMs)) {
        throw new TypeError("invalid calibration audit context");
    }
    try {
        appendAuditSync(Object.freeze({
            kind: "embodiment.effector",
            eventType: "calibration-change",
            effectorId,
            calibrationRef,
            atMs
        }));
    } catch {
        throw new Error("calibration audit failed; change refused");
    }
}

module.exports = Object.freeze({ validateCalibration, applyCalibration, auditCalibrationChange });
