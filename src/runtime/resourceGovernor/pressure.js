"use strict";

const { PRESSURE_BANDS, isFiniteNumber, freezeDeep } = require("./model");

function ratioFromFree(total, free) {
    if (!isFiniteNumber(total) || !isFiniteNumber(free) || total <= 0) return null;
    return Math.max(0, Math.min(1, 1 - free / total));
}

function safeRatio(numerator, denominator) {
    if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator) || denominator <= 0 || numerator < 0) {
        return null;
    }
    return Math.max(0, Math.min(1, numerator / denominator));
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

/**
 * Pressure formula (all ratios clamped to [0,1], all bands from config):
 *   hostBand      = band(1 - freeMemBytes/totalMemBytes,            memoryThresholds.hostUsedMemoryRatio)
 *   v8Band        = band(heapUsedBytes / heapLimitBytes,            memoryThresholds.processHeapUsedRatio)
 *                   where heapLimitBytes = v8.getHeapStatistics().heap_size_limit
 *   footprintBand = band(rssBytes / totalMemBytes,                  memoryThresholds.processHeapUsedRatio)
 *   nativeBand    = band((externalBytes + arrayBuffersBytes) / heapLimitBytes,
 *                        memoryThresholds.processHeapUsedRatio)
 *   hardFloorHit  = freeMemBytes <= memoryThresholds.hostHardFloorBytes  => forces CRITICAL
 *   band          = worstOf(hostBand, v8Band, footprintBand, nativeBand)
 * Missing/invalid readings drop their contribution; no contributions at all
 * or unhealthy observation => UNKNOWN.
 */
function computePressureBand({ snapshot, config }) {
    if (snapshot === null || typeof snapshot !== "object" || snapshot.observerHealthy !== true) {
        return freezeDeep({ band: PRESSURE_BANDS.UNKNOWN, contributions: {} });
    }
    const memThresholds = config.memoryThresholds;

    const hostUsedRatio = ratioFromFree(snapshot.totalMemBytes, snapshot.freeMemBytes);
    const hostBand = bandForRatio(hostUsedRatio, memThresholds.hostUsedMemoryRatio);

    const v8HeapRatio = safeRatio(snapshot.heapUsedBytes, snapshot.heapLimitBytes);
    const v8Band = bandForRatio(v8HeapRatio, memThresholds.processHeapUsedRatio);

    const rssRatio = safeRatio(snapshot.rssBytes, snapshot.totalMemBytes);
    const footprintBand = bandForRatio(rssRatio, memThresholds.processHeapUsedRatio);

    let nativeRatio = null;
    if (isFiniteNumber(snapshot.externalBytes) || isFiniteNumber(snapshot.arrayBuffersBytes)) {
        const nativeBytes = Math.max(0, snapshot.externalBytes ?? 0) + Math.max(0, snapshot.arrayBuffersBytes ?? 0);
        nativeRatio = safeRatio(nativeBytes, snapshot.heapLimitBytes);
    }
    const nativeBand = bandForRatio(nativeRatio, memThresholds.processHeapUsedRatio);

    const hardFloorHit = snapshot.freeMemBytes !== undefined &&
        isFiniteNumber(snapshot.freeMemBytes) &&
        snapshot.freeMemBytes <= memThresholds.hostHardFloorBytes;

    const lagBand = bandForLag(snapshot.eventLoopLagMs, config.eventLoopLagMs);

    let band = worstBand([hostBand, v8Band, footprintBand, nativeBand, lagBand]);
    if (band === null) return freezeDeep({ band: PRESSURE_BANDS.UNKNOWN, contributions: {} });
    if (hardFloorHit) band = PRESSURE_BANDS.CRITICAL;

    return freezeDeep({
        band,
        contributions: freezeDeep({
            hostUsedRatio, hostBand, v8HeapRatio, v8Band,
            rssRatio, footprintBand, nativeRatio, nativeBand,
            lagMs: isFiniteNumber(snapshot.eventLoopLagMs) ? snapshot.eventLoopLagMs : null,
            lagBand, hardFloorHit
        })
    });
}

module.exports = { computePressureBand, worstBand };
