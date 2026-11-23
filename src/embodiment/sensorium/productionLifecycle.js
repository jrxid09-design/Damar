"use strict";

const { runDiscoveryCycle, validateAdapter } = require("../discovery/adapter");

/**
 * Composition-owned production lifecycle for a Sensorium discovery adapter.
 * It schedules only the adapter it was given, performs one deterministic boot
 * cycle, and owns the timer until stop.  It does not own BodySchema state.
 */
function createProductionSensoriumLifecycle({ body, adapter, intervalMs = 60_000,
    onError = null } = {}) {
    if (!body || typeof body.registerProducer !== "function") {
        throw new TypeError("production Sensorium lifecycle requires BodySchema");
    }
    validateAdapter(adapter);
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 24 * 60 * 60 * 1000) {
        throw new TypeError("intervalMs must be between 100ms and 24h");
    }

    let timer = null;
    let state = "NEW";
    let cycleInFlight = false;
    let cycleCount = 0;
    let lastError = null;

    function report(error) {
        lastError = String(error?.message ?? error).slice(0, 240);
        try { onError?.(error); } catch { /* diagnostics never break lifecycle */ }
    }

    function runOnce() {
        if (state !== "STARTED" || cycleInFlight) return { skipped: true };
        cycleInFlight = true;
        try {
            const result = runDiscoveryCycle(body, adapter);
            cycleCount++;
            return { ok: true, result };
        } catch (error) {
            report(error);
            return { ok: false, error };
        } finally { cycleInFlight = false; }
    }

    function start() {
        if (state === "STARTED") return status();
        if (state === "STOPPED") throw new Error("Sensorium lifecycle cannot restart after stop");
        body.registerProducer(adapter.id);
        state = "STARTED";
        const initial = runOnce();
        timer = setInterval(runOnce, intervalMs);
        // The lifecycle owns the timer; unref keeps test/process teardown from
        // depending on a forgotten shutdown while production remains active.
        timer.unref?.();
        return { ...status(), initial };
    }

    function stop() {
        if (timer !== null) clearInterval(timer);
        timer = null;
        cycleInFlight = false;
        state = "STOPPED";
        return status();
    }

    function status() {
        return Object.freeze({
            state, sensorId: adapter.id, cycleCount,
            timerActive: timer !== null, lastError
        });
    }

    return Object.freeze({ start, stop, runOnce, status });
}

module.exports = { createProductionSensoriumLifecycle };
