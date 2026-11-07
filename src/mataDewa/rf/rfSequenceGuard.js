"use strict";

/** Bounded sequence/replay guard; sequence evidence never creates authority. */
const UINT32_MAX = 0xffffffff;
const HALF_RANGE = 0x80000000;

class RfSequenceGuard {
    constructor() {
        this.lastSequence = null;
        this.accepted = 0;
        this.rejected = 0;
    }

    accept(sequence) {
        if (!Number.isInteger(sequence) || sequence < 0 || sequence > UINT32_MAX) {
            this.rejected += 1;
            return { ok: false, reason: "RF_SEQUENCE_INVALID" };
        }
        if (this.lastSequence === null) {
            this.lastSequence = sequence;
            this.accepted += 1;
            return { ok: true, sequence };
        }
        const delta = (sequence - this.lastSequence) >>> 0;
        if (delta === 0) {
            this.rejected += 1;
            return { ok: false, reason: "RF_SEQUENCE_REPLAY" };
        }
        if (delta >= HALF_RANGE) {
            this.rejected += 1;
            return { ok: false, reason: "RF_SEQUENCE_OUT_OF_ORDER" };
        }
        this.lastSequence = sequence;
        this.accepted += 1;
        return { ok: true, sequence };
    }

    reset() {
        this.lastSequence = null;
        this.accepted = 0;
        this.rejected = 0;
    }

    describe() {
        return Object.freeze({ lastSequence: this.lastSequence, accepted: this.accepted, rejected: this.rejected });
    }
}

module.exports = Object.freeze({ RfSequenceGuard });
