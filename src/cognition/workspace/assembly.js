"use strict";

function makeAssembly(bounds) {
    function getAssembly(items) {
        // RT-W10-01: safety items must survive flooding — reserve slots for them
        const safetyItems = items.filter(i => i.safety === true);
        const nonSafetyItems = items.filter(i => i.safety !== true);

        // Sort non-safety by salience desc
        nonSafetyItems.sort((a, b) => (b.salience || 0) - (a.salience || 0));

        const reservedForSafety = Math.min(safetyItems.length, bounds.RESERVED_SAFETY_SLOTS);
        const slotsForNonSafety = bounds.MAX_STAGE_ASSEMBLIES - reservedForSafety;

        const assembly = [
            ...safetyItems.slice(0, reservedForSafety),
            ...nonSafetyItems.slice(0, Math.max(0, slotsForNonSafety)),
        ];

        return assembly.slice(0, bounds.MAX_STAGE_ASSEMBLIES);
    }

    function checkTokenCeiling(assemblyItems) {
        const total = assemblyItems.reduce((sum, i) => sum + (i.tokens || 0), 0);
        if (total > bounds.MAX_ASSEMBLY_TOKENS) {
            throw new Error(`Assembly token ceiling (${bounds.MAX_ASSEMBLY_TOKENS}) exceeded — token limit enforced (W10-L1/RT-W10-07)`);
        }
        return total;
    }

    return { getAssembly, checkTokenCeiling };
}

module.exports = { makeAssembly };
