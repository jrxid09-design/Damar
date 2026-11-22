"use strict";

const { newRuntimeGenerationId, coerceRuntimeGenerationId } = require("./ids");

/**
 * RuntimeGenerationId (R16).
 *
 * Every successful recovery or clean startup conceptually enters a new
 * runtime generation. Stale async work from an older generation must never
 * be mistaken for current work: callers stamp work with the generation id
 * and verify with assertCurrent before acting on completion.
 *
 * V0 models this only; it does not modify the existing runtime.
 */
class GenerationLedger {
    constructor() {
        this.current = newRuntimeGenerationId();
        this.history = Object.freeze([this.current]);
    }

    advance(reason) {
        if (typeof reason !== "string" || reason.length === 0) {
            throw new TypeError("generation advance requires a reason");
        }
        const next = newRuntimeGenerationId();
        this.current = next;
        this.history = Object.freeze([...this.history, next]);
        return { generationId: next, previousGenerationId: this.history[this.history.length - 2] };
    }

    isCurrent(id) {
        try {
            return coerceRuntimeGenerationId(id) === this.current;
        } catch {
            return false;
        }
    }

    /** Throws when work stamped with a stale generation is presented. */
    assertCurrent(id) {
        if (!this.isCurrent(id)) {
            const err = new RangeError("stale runtime generation");
            err.code = "E_STALE_RUNTIME_GENERATION";
            throw err;
        }
        return true;
    }
}

module.exports = Object.freeze({ GenerationLedger });
