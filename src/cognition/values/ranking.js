"use strict";

function rankOptions(options, preferences) {
    // RT-W10-37: character never expands the option set — return only original options, sorted
    if (!options || options.length === 0) return [];
    const originalSet = new Set(options.map(o => o.id || JSON.stringify(o)));
    const sorted = [...options].sort((a, b) => {
        const pref = preferences || [];
        const scoreA = pref.filter(p => a.tags && a.tags.includes(p.subject && p.subject.ref)).reduce((s, p) => s + (p.strength || 0), 0);
        const scoreB = pref.filter(p => b.tags && b.tags.includes(p.subject && p.subject.ref)).reduce((s, p) => s + (p.strength || 0), 0);
        return scoreB - scoreA;
    });
    return sorted.filter(o => originalSet.has(o.id || JSON.stringify(o)));
}

function resolveConflict(values) {
    // RT-W10-36: conflict ranking must be owner-set; if missing, ask owner + behave conservatively
    const ranked = values.filter(v => v.precedenceRank !== null && v.precedenceRank !== undefined);
    if (ranked.length < values.length) {
        return { needsOwner: true, reason: "missing_precedence_rank", conservativeBehavior: true };
    }
    return { needsOwner: false, ranked: [...values].sort((a, b) => b.precedenceRank - a.precedenceRank) };
}

module.exports = { rankOptions, resolveConflict };
