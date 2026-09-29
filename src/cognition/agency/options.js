"use strict";

// RT-W10-43: nonsense options filtered before ranking
function isCoherentOption(option) {
    if (!option || typeof option !== "object") return false;
    if (!option.id) return false;
    if (typeof option.text !== "string") return false;
    if (option.text.trim().length === 0) return false;
    return true;
}

function filterOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) return [];
    return rawOptions.filter(isCoherentOption);
}

module.exports = { filterOptions, isCoherentOption };
