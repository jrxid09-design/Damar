"use strict";

function createWisesRecoveryProvider({ restart, canary = null, maxAttempts = 1 } = {}) {
    if (typeof restart !== "function") throw new TypeError("WISES_RESTART_REQUIRED");
    let attempts = 0;
    return Object.freeze({
        id: "wises-local",
        async restart() {
            if (attempts >= Math.max(0, Math.min(3, maxAttempts | 0))) throw new Error("WISES_RECOVERY_ATTEMPTS_EXHAUSTED");
            attempts++;
            await restart();
            if (canary) await canary();
            return Object.freeze({ attempts });
        },
        snapshot() { return Object.freeze({ id: "wises-local", attempts, maxAttempts }); }
    });
}

module.exports = Object.freeze({ createWisesRecoveryProvider });
