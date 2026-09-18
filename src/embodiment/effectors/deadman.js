"use strict";

function createDeadman({ now = () => Date.now(), timeoutMs = 1000, stop }) {
    if (typeof now !== "function" || typeof stop !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("invalid deadman configuration");
    }
    let lastHeartbeat = now();
    let stopped = false;
    return Object.freeze({
        heartbeat() {
            if (stopped) return false;
            const at = now();
            if (!Number.isFinite(at) || at < lastHeartbeat) return false;
            lastHeartbeat = at;
            return true;
        },
        check() {
            if (stopped) return false;
            const at = now();
            if (!Number.isFinite(at) || at - lastHeartbeat > timeoutMs) {
                stopped = true;
                try { stop(); } catch { /* stop remains latched even if hardware is unreachable */ }
                return false;
            }
            return true;
        },
        stop() {
            if (stopped) return false;
            stopped = true;
            try { stop(); } catch { /* best effort physical safe stop */ }
            return true;
        },
        isStopped: () => stopped
    });
}

module.exports = Object.freeze({ createDeadman });
