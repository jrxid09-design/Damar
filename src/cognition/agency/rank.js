"use strict";

function scoreOption(option, preferences) {
    let score = 0;
    for (const pref of preferences) {
        if (option.text && pref.statement) {
            const keyword = (pref.subject && pref.subject.ref || pref.statement || "").slice(0, 16).toLowerCase();
            if (option.text.toLowerCase().includes(keyword)) {
                score += typeof pref.strength === "number" ? pref.strength : 0.5;
            }
        }
    }
    return score;
}

// RT-W10-44: values never expand option set — sort only, never add
// _values accepted for API consistency; L5 ranking is preference-driven only
function rankOptions(options, preferences, _values) {
    if (!Array.isArray(options)) return [];
    const originalIds = new Set(options.map(o => o.id));
    const ranked = [...options].sort((a, b) => scoreOption(b, preferences || []) - scoreOption(a, preferences || []));
    return ranked.filter(o => originalIds.has(o.id));
}

module.exports = { rankOptions };
