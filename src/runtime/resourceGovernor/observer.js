"use strict";

const os = require("node:os");
const v8 = require("node:v8");
const perfHooks = require("node:perf_hooks");

class HostResourceObserver {
    constructor() {
        this._delayMonitor = perfHooks.monitorEventLoopDelay({ resolution: 10 });
        this._delayMonitor.enable();
    }

    observe() {
        const mem = process.memoryUsage();
        let heapLimitBytes = null;
        try {
            heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
        } catch {
            heapLimitBytes = null;
        }
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
            heapLimitBytes,
            externalBytes: mem.external,
            arrayBuffersBytes: mem.arrayBuffers,
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
