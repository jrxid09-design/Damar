"use strict";

const MODES = Object.freeze(["healthy", "401", "429", "404", "500", "503", "timeout", "reset", "malformed", "empty", "stream"]);
function createFaultAdapter(mode = "healthy") {
    if (!MODES.includes(String(mode))) throw new TypeError("FAULT_MODE_INVALID");
    return Object.freeze({
        async scanModels() { if (mode === "malformed") return { invalid: true }; return [{ id: "fault-model", name: "Fault Model", streaming: true }]; },
        async testCredential() { if (mode !== "healthy") throw errorFor(mode); return true; },
        async invoke() { if (mode !== "healthy") throw errorFor(mode); return { content: "fault-harness-ok", mode }; }
    });
}
function errorFor(mode) { const e = new Error(`FAULT_${String(mode).toUpperCase()}`); e.status = ({ "401": 401, "429": 429, "404": 404, "500": 500, "503": 503 }[mode] ?? null); e.code = mode === "timeout" ? "CONNECT_TIMEOUT" : mode === "reset" ? "ECONNRESET" : undefined; e.failureClass = mode === "empty" ? "EMPTY_RESPONSE" : mode === "stream" ? "STREAM_FAILURE" : undefined; return e; }
module.exports = Object.freeze({ MODES, createFaultAdapter });
