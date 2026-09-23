"use strict";

/* Desktop APIs are ingress adapters only. The PowerShell actuator is owned by
 * the canonical Lane 3 composition; these functions never launch a process. */

const { executeCanonicalAction } = require("./canonicalActionClient");

function action(operation, parameters, context) {
    return executeCanonicalAction({
        context,
        capabilityId: "damar.desktop",
        operation,
        arguments: parameters,
        // Invocation-only desktop effects intentionally remain inconclusive
        // unless a domain verifier supplies independent evidence. listWindows
        // has a concrete observed data contract.
        // Invocation-only effects cannot honestly be reported as VERIFIED.
        // Omitting a postcondition makes Lane 4 preserve that uncertainty;
        // listWindows has an actual observed data contract.
        expectedPostcondition: operation === "listWindows"
            ? { expect: { windows: { op: "type", value: "array" } } }
            : null
    });
}

function openApp(name, args = "", context = null) {
    return action("openApp", { name, args }, context);
}
function typeText(text, context = null) { return action("typeText", { text }, context); }
function pressKey(key, context = null) { return action("pressKey", { key }, context); }
function fillForm(field, value, context = null) { return action("fillForm", { field, value }, context); }
function listWindows(context = null) { return action("listWindows", {}, context); }
function moveMouse(x, y, context = null) { return action("moveMouse", { x, y }, context); }
function clickMouse(button = "left", x = null, y = null, context = null) {
    return action("click", { button, x, y }, context);
}

module.exports = Object.freeze({ openApp, typeText, pressKey, fillForm, listWindows, moveMouse, clickMouse });
