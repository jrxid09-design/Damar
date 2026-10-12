"use strict";

/*
 * One effect classifier for every ToolRegistry/safety/verification caller.
 * A tool's label is only metadata; executable capability evidence wins.
 */
const EFFECT = Object.freeze({
    READ_LOCAL_STATE: "READ_LOCAL_STATE",
    READ_EXTERNAL_STATE: "READ_EXTERNAL_STATE",
    WRITE_LOCAL_STATE: "WRITE_LOCAL_STATE",
    WRITE_EXTERNAL_STATE: "WRITE_EXTERNAL_STATE",
    CREATE_RESOURCE: "CREATE_RESOURCE",
    UPDATE_RESOURCE: "UPDATE_RESOURCE",
    DELETE_RESOURCE: "DELETE_RESOURCE",
    SEND_MESSAGE: "SEND_MESSAGE",
    EXECUTE_PROCESS: "EXECUTE_PROCESS",
    EXECUTE_CODE: "EXECUTE_CODE",
    CONTROL_DEVICE: "CONTROL_DEVICE",
    CHANGE_SECURITY_STATE: "CHANGE_SECURITY_STATE",
    OTHER_SIDE_EFFECT: "OTHER_SIDE_EFFECT",
    UNKNOWN: "UNKNOWN"
});

const READ_ONLY = new Set([EFFECT.READ_LOCAL_STATE, EFFECT.READ_EXTERNAL_STATE]);
const HTTP_READ = new Set(["get", "head", "options"]);
const HTTP_WRITE = new Map([
    ["post", EFFECT.CREATE_RESOURCE], ["put", EFFECT.UPDATE_RESOURCE],
    ["patch", EFFECT.UPDATE_RESOURCE], ["delete", EFFECT.DELETE_RESOURCE]
]);

function declaredEffect(tool) {
    return tool?.effectClass ?? tool?.metadata?.effectClass ?? tool?.meta?.effectClass
        ?? tool?.effectContract?.class ?? tool?.metadata?.effectContract?.class;
}

function sourceLooksConsequential(tool) {
    const seen = new Set();
    const parts = [];
    const visit = value => {
        if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
        seen.add(value);
        if (typeof value === "function") parts.push(Function.prototype.toString.call(value));
        for (const key of ["execute", "run", "_impl"]) {
            try { visit(value[key]); } catch { return; }
        }
    };
    visit(tool);
    const source = parts.join("\n");
    return /(?:fs\.(?:writeFile|appendFile|unlink|rm|mkdir|rename|copyFile)|\b(?:writeFileSync|appendFileSync|unlinkSync|spawn|execSync|fork)\b|child_process|http\.request|https\.request|\bfetch\s*\([^)]*\{[^}]*\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)|\b(?:send|publish|broadcast|sendMessage|controlDevice)\s*\()/.test(source);
}

function classifyEffect(id, tool = null) {
    const raw = String(id ?? "");
    const tail = raw.split(".").pop().toLowerCase();
    if (raw.toLowerCase().startsWith("http.")) {
        if (HTTP_READ.has(tail)) return { effectClass: EFFECT.READ_EXTERNAL_STATE, consequential: false, known: true };
        if (HTTP_WRITE.has(tail)) return { effectClass: HTTP_WRITE.get(tail), consequential: true, known: true };
    }
    const declared = declaredEffect(tool);
    if (declared && Object.values(EFFECT).includes(declared)) {
        if (READ_ONLY.has(declared) && sourceLooksConsequential(tool)) {
            return { effectClass: EFFECT.UNKNOWN, consequential: true, known: false, reason: "DECLARATION_CONFLICTS_WITH_CAPABILITY" };
        }
        return { effectClass: declared, consequential: !READ_ONLY.has(declared), known: true };
    }
    if (sourceLooksConsequential(tool)) return { effectClass: EFFECT.OTHER_SIDE_EFFECT, consequential: true, known: true };
    if (tool?.readOnly === true || tool?.metadata?.readOnly === true || tool?.meta?.readOnly === true) {
        return { effectClass: EFFECT.READ_LOCAL_STATE, consequential: false, known: true };
    }
    return { effectClass: EFFECT.UNKNOWN, consequential: true, known: false, reason: "EFFECT_NOT_PROVEN" };
}

module.exports = Object.freeze({ EFFECT, classifyEffect, sourceLooksConsequential });
