"use strict";

function applyCharacter(options, preferences, values) {
    // RT-W10-32: values outrank preferences for disclosure
    // RT-W10-37: never expands the option set
    if (!options || options.length === 0) return [];

    const disclosures = options.filter(o => o.kind === "disclosure" || o.required === true);
    const others = options.filter(o => o.kind !== "disclosure" && o.required !== true);

    // Values protect disclosures regardless of brevity preferences
    const hasDisclosureValue = values && values.some(v => /honest|disclose|uncertain|transparency/i.test(v.statement || ""));
    const keptDisclosures = (disclosures.length > 0 && hasDisclosureValue) ? disclosures : disclosures;

    // Brevity preference may trim non-disclosure options only
    const brevityPref = preferences && preferences.find(p => /brief|concise|short/i.test(p.statement || ""));
    const resultOthers = (brevityPref && others.length > 1)
        ? others.slice(0, Math.max(1, Math.ceil(others.length / 2)))
        : others;

    return [...keptDisclosures, ...resultOthers];
}

module.exports = { applyCharacter };
