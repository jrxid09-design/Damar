"use strict";

function makeStopHandler() {
    let stopped = false;

    function signal() { stopped = true; }
    function isSignaled() { return stopped; }
    function check() {
        if (stopped) throw new Error("Stop signaled — operation halted immediately (W9-L3/RT-W9-30)");
    }

    return { signal, isSignaled, check };
}

module.exports = { makeStopHandler };
