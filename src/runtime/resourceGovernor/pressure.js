"use strict";

const { PRESSURE_BANDS, isFiniteNumber, freezeDeep } = require("./model");

function ratioFromFree(total, free) {
    if (!isFiniteNumber(total) || !isFiniteNumber(free) || total <= 0) return null;
    return Math.max(0, Math.min(1, 1 - free / total));
}

function bandForRatio(usedRatio, thresholds) {
    if (usedRatio === null) return null;
    if (usedRatio >= thresholds.critical) return PRESSURE_BANDS.CRITICAL;
    if (usedRatio >= thresholds.high) return PRESSURE_BANDS.HIGH;
    if (usedRatio >= thresholds.elevated) return PRESSURE_BANDS.ELEVATED;
    return PRESSURE_BANDS.NORMAL;
}

function bandForLag(lagMs, thresholds) {
    if (!isFiniteNumber(lagMs)) return null;
    if (lagMs >= thresholds.critical) return PRESSURE_BANDS.CRITICAL;
    if (lagMs >= thresholds.high) return PRESSURE_BANDS.HIGH;
    if (lagMs >= thresholds.elevated) return PRESSURE_BANDS.ELEVATED;
    return PRESSURE_BANDS.NORMAL;
}

const BAND_RANK = Object.freeze({
    [PRESSURE_BANDS.NORMAL]: 0,
    [PRESSURE_BANDS.ELEVATED]: 1,
    [PRESSURE_BANDS.HIGH]: 2,
    [PRESSURE_BANDS.CRITICAL]: 3,
    [PRESSURE_BANDS.UNKNOWN]: -1
});

function worstBand(bands) {
    let worst = null;
    for (const b of bands) {
        if (b === null || b === undefined) continue;
        if (b === PRESSURE_BANDS.CRITICAL) return PRESSURE_BANDS.CRITICAL;
        if (worst === null || BAND_RANK[b] > BAND_RANK[worst]) worst = b;
    }
    return worst;
}

function computePressureBand({ snapshot, config }) {
    if (snapshot === null || typeof snapshot !== "object" || snapshot.observerHealthy !== true) {
        return { band: PRESSURE_BANDS.UNKNOWN, contributions: {} };
    }
    const hostUsedRatio = ratioFromFree(snapshot.totalMemBytes, snapshot.freeMemBytes);
    const hostBand = bandForRatio(hostUsedRatio, config.memoryThresholds.hostUsedMemoryRatio);

    let processBand = null;
    if (snapshot.heapLimitBytes && isFiniteNumber(snapshot.heapLimitBytes) &&
        isFiniteNumber(snapshot.heapUsedBytes) && snapshot.heapLimitBytes > 0) {
        processBand = bandForRatio(snapshot.heapUsedBytes / snapshot.heapLimitBytes,
            config.memoryThresholds.processHeapUsedRatio);
    }

    const lagBand = bandForLag(snapshot.eventLoopLagMs, config.eventLoopLagMs);

    const hardFloorHit = hostUsedRatio !== null && snapshot.freeMemBytes <= config.memoryThresholds.hostHardFloorBytes;

    let band = worstBand([hostBand, processBand, lagBand]);
    if (band === null) return { band: PRESSURE_BANDS.UNKNOWN, contributions: {} };
    if (hardFloorHit) band = PRESSURE_BANDS.CRITICAL;

    return freezeDeep({
        band,
        contributions: freezeDeep({
            hostUsedRatio, hostBand, processBand, lagBand, hardFloorHit
        })
    });
}

module.exports = { computePressureBand, worstBand };
