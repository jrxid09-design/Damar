"use strict";

const os = require("node:os");
const perfHooks = require("node:perf_hooks");

class HostResourceObserver {
    constructor() {
        this._delayMonitor = perfHooks.monitorEventLoopDelay({ resolution: 10 });
        this._delayMonitor.enable();
    }

    observe() {
        const mem = process.memoryUsage();
        const sample = this._delayMonitor;
        let eventLoopLagMs = null;
        if (sample && typeof sample.mean === "number" && Number.isFinite(sample.mean)) {
            eventLoopLagMs = sample.mean / 1e6;
            sample.reset();
        }
        return Object.freeze({
            totalMemBytes: os.totalmem(),
            freeMemBytes: os.freemem(),
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            heapLimitBytes: Number.isFinite(mem.heapTotal) ? mem.heapTotal : null,
            eventLoopLagMs,
            processUptimeSec: process.uptime()
        });
    }

    close() {
        try { this._delayMonitor.disable(); } catch { /* already disabled */ }
    }
}

function createHostResourceObserver() {
    return new HostResourceObserver();
}

module.exports = { createHostResourceObserver, HostResourceObserver };
