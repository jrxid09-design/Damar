"use strict";

const { freezeDeep } = require("./model");

class AdmissionQueue {
    constructor({ capacity, aging }) {
        this._capacity = capacity;
        this._aging = aging;
        this._entries = [];
        this._nextSeq = 0;
    }

    get size() { return this._entries.length; }
    get capacity() { return this._capacity; }
    get isFull() { return this._entries.length >= this._capacity; }

    effectivePriority(entry, nowMs) {
        const waitedMs = Math.max(0, nowMs - entry.enqueuedAt);
        const bonus = Math.min(this._aging.maxBonus,
            (waitedMs / 10000) * this._aging.bonusPer10s);
        return entry.basePriority + bonus;
    }

    enqueue({ workloadId, demand, basePriority, enqueuedAt }) {
        if (this.isFull) return null;
        const entry = freezeDeep({
            seq: ++this._nextSeq,
            workloadId,
            demand,
            basePriority,
            enqueuedAt
        });
        this._entries.push(entry);
        return entry;
    }

    dequeueBest(nowMs) {
        if (this._entries.length === 0) return null;
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < this._entries.length; i++) {
            const score = this.effectivePriority(this._entries[i], nowMs);
            if (score > bestScore + Number.EPSILON) {
                bestScore = score;
                bestIdx = i;
            }
        }
        return this._entries.splice(bestIdx, 1)[0];
    }

    removeByWorkloadId(workloadIdValue) {
        const idx = this._entries.findIndex(e => e.workloadId === workloadIdValue);
        if (idx === -1) return false;
        this._entries.splice(idx, 1);
        return true;
    }

    entries(nowMs) {
        if (nowMs === undefined) return Object.freeze([...this._entries]);
        return Object.freeze(
            [...this._entries]
                .map(e => ({ entry: e, eff: this.effectivePriority(e, nowMs) }))
                .sort((a, b) => b.eff - a.eff || a.entry.seq - b.entry.seq)
                .map(x => x.entry)
        );
    }
}

module.exports = { AdmissionQueue };
