"use strict";

class BudgetExhaustedError extends Error {
    constructor(msg) {
        super(msg);
        this.name = "BudgetExhaustedError";
        this.requiresDefer = true;
    }
}

// RT-W10-41: deliberation budget enforced — loop cannot run forever; ends in ask-or-defer
function makeDeliberationBudget(bounds) {
    const maxCycles = (bounds && bounds.MAX_DELIBERATION_CYCLES) || 16;
    let cycles = 0;
    function tick() {
        cycles++;
        if (cycles >= maxCycles) {
            throw new BudgetExhaustedError(
                `Deliberation budget exhausted after ${maxCycles} cycles — ask-or-defer required (W10-L5/RT-W10-41)`
            );
        }
    }
    function remaining() {
        return Math.max(0, maxCycles - cycles);
    }
    return { tick, remaining, maxCycles };
}

module.exports = { makeDeliberationBudget, BudgetExhaustedError };
