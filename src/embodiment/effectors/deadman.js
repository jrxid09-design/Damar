"use strict";

function createDeadman({ now = () => Date.now(), timeoutMs = 1000, stop }) {
    if (typeof now !== "function" || typeof stop !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("invalid deadman configuration");
    }
    let lastHeartbeat = now();
    let lastObservedAt = lastHeartbeat;
    let stopped = false;
    let stopSucceeded = null;
    if (!Number.isFinite(lastHeartbeat)) throw new TypeError("deadman clock must start finite");
    function latchStop() {
        if (stopped) return false;
        stopped = true;
        try { stop(); stopSucceeded = true; } catch { stopSucceeded = false; }
        return true;
    }
    return Object.freeze({
        heartbeat() {
            if (stopped) return false;
            const at = now();
            if (!Number.isFinite(at) || at < lastHeartbeat || at < lastObservedAt) {
                latchStop();
                return false;
            }
            lastObservedAt = at;
            lastHeartbeat = at;
            return true;
        },
        check() {
            if (stopped) return false;
            const at = now();
            if (!Number.isFinite(at) || at < lastObservedAt || at - lastHeartbeat > timeoutMs) {
                lastObservedAt = Number.isFinite(at) ? at : lastObservedAt;
                latchStop();
                return false;
            }
            lastObservedAt = at;
            return true;
        },
        stop() {
            return latchStop();
        },
        isStopped: () => stopped,
        didStopSucceed: () => stopSucceeded,
        timeoutMs: () => timeoutMs
    });
}

module.exports = Object.freeze({ createDeadman });
