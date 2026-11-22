"use strict";

function classifyDescriptor(descriptor, safeClone, classCost, gainForClass) {
    const d = safeClone(descriptor);
    const evidence = [];
    function collect(value, depth = 0) {
        if (depth > 8 || value === null || value === undefined) return;
        if (typeof value === "string") evidence.push(value.toLowerCase());
        else if (typeof value === "boolean" && value) evidence.push("true");
        else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1);
        else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { evidence.push(key.toLowerCase()); collect(item, depth + 1); }
    }
    collect(d);
    const evidenceText = evidence.join(" ");
    const privateData = d.containsPrivateData === true || evidence.some(value => /\b(private|sensitive|personal|confidential|restricted)\b/.test(value));
    const cls = /unknown|ambiguous|unclassified|world|actuat|write|control|physical|effect|mutat|delete|command|motor|motion|dispense/.test(evidenceText) ? "WORLD_CHANGING" :
        /remote|network|cloud|external/.test(evidenceText) ? "REMOTE" :
        privateData || /interactive|camera|microphone|sensor/.test(evidenceText) ? "INTERACTIVE" :
        /local|read|query/.test(evidenceText) ? "LOCAL" : "WORLD_CHANGING";
    return { cls, gain: gainForClass(cls), cost: classCost[cls], privacyClass: privateData ? "PRIVATE" : "PUBLIC" };
}

module.exports = { classifyDescriptor };
