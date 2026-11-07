/**
 * Jam dapat-disuntik (§75). Reducer ACC TIDAK memanggil Date.now()
 * langsung — decay/TTL/horizon/replay butuh waktu deterministik.
 */

function realClock() {
    return {
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString()
    };
}

/** Jam uji: maju manual, tanpa sleep. */
function manualClock(startMs = 0) {
    let t = startMs;
    return {
        nowMs: () => t,
        nowIso: () => new Date(t).toISOString(),
        advance(ms) { t += ms; return t; },
        set(ms) { t = ms; return t; }
    };
}

module.exports = { realClock, manualClock };
